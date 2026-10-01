import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env";
import type { NarratorCtx, RunNarrator } from "../narrator";
import {
  TEST_NOTES,
  buildTestApp,
  echoNarrator,
  fakeEnvelope,
  mintUser,
  readJson,
} from "../test-helpers";

async function authed(
  app: ReturnType<typeof buildTestApp>["app"],
  token: string,
  path: string,
  init: RequestInit = {},
) {
  return app.request(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}

async function createGame(app: ReturnType<typeof buildTestApp>["app"], token: string) {
  const res = await authed(app, token, "/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Freighter Run" }),
  });
  return (await res.json()) as { game: { id: string } };
}

function narratorBody(gameId: string, savedAtTick = 0, hookKind = "approachingPort") {
  return {
    gameId,
    hook: { kind: hookKind },
    snapshot: fakeEnvelope({ savedAtTick }),
    recentEvents: [],
  };
}

describe("narrator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a fallback reply as one structured warn line, without the API key (D42)", async () => {
    const env = loadEnv({ CREW_DB: "memory", OPENROUTER_API_KEY: "sk-or-secret-key" });
    const fallbackNarrator: RunNarrator = async () => ({
      response: {
        commands: [],
        callId: "fallback-call",
        model: "null-narrator",
        promptVersion: "v0.8",
        fallback: "apiError",
        notesUpdate: TEST_NOTES,
      },
      error: "OpenRouter 402: insufficient credits",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = buildTestApp({ env, runNarrator: fallbackNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id)),
    });
    expect(res.status).toBe(200);

    const fallbackLines = warn.mock.calls.filter((call) => call[0] === "[narrator] fallback");
    expect(fallbackLines).toHaveLength(1);
    const logged = fallbackLines[0]?.[1] as Record<string, unknown>;
    expect(logged).toMatchObject({
      gameId: game.id,
      hookKind: "approachingPort",
      fallback: "apiError",
      model: "null-narrator",
      promptVersion: "v0.8",
      error: "OpenRouter 402: insufficient credits",
    });
    expect(typeof logged.latencyMs).toBe("number");
    expect(JSON.stringify(logged)).not.toContain("sk-or-secret-key");
    expect(logged).not.toHaveProperty("request");
  });

  it("does not warn when the reply is not a fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = buildTestApp({ runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);
    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id)),
    });
    expect(res.status).toBe(200);
    expect(warn.mock.calls.filter((call) => call[0] === "[narrator] fallback")).toHaveLength(0);
  });

  it("calls the injected narrator and logs the call", async () => {
    const env = loadEnv({ CREW_DB: "memory" });
    const { app, db } = buildTestApp({ env, runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id)),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.commands).toEqual([]);
    expect(body.notesUpdate.summary).toBe("updated notes");

    const lastCall = await db.getLastNarratorCall(game.id);
    expect(lastCall?.status).toBe("ok");
  });

  it("429s once the hourly call budget is exceeded, and logs the rejection", async () => {
    const env = loadEnv({ CREW_DB: "memory", CREW_NARRATOR_MAX_CALLS_PER_HOUR: "1" });
    const { app, db } = buildTestApp({ env, runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const first = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id, 0)),
    });
    expect(first.status).toBe(200);

    const second = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id, 500)),
    });
    expect(second.status).toBe(429);
    const secondBody = await readJson(second);
    expect(secondBody.error.code).toBe("budgetExceeded");

    const lastCall = await db.getLastNarratorCall(game.id);
    expect(lastCall?.status).toBe("budgetExceeded");
  });

  it("429s a call too soon after the last one, but not a policyDecision hook (D37)", async () => {
    const env = loadEnv({ CREW_DB: "memory", CREW_NARRATOR_MAX_CALLS_PER_HOUR: "10" });
    const { app, db } = buildTestApp({ env, runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);
    const post = (body: unknown) =>
      authed(app, token, `/api/games/${game.id}/narrator`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post(narratorBody(game.id, 0))).status).toBe(200);

    const tooSoon = await post(narratorBody(game.id, 40));
    expect(tooSoon.status).toBe(429);
    expect((await readJson(tooSoon)).error.message).toMatch(/too soon/i);

    // The player is waiting on the card: spacing does not apply.
    const policy = await post(narratorBody(game.id, 40, "policyDecision"));
    expect(policy.status).toBe(200);
    expect((await db.getLastNarratorCall(game.id))?.hookKind).toBe("policyDecision");

    // The hourly cap still does.
    const capped = loadEnv({ CREW_DB: "memory", CREW_NARRATOR_MAX_CALLS_PER_HOUR: "1" });
    const second = buildTestApp({ env: capped, runNarrator: echoNarrator });
    const user = await mintUser(second.app);
    const { game: other } = await createGame(second.app, user.token);
    const postOther = (body: unknown) =>
      authed(second.app, user.token, `/api/games/${other.id}/narrator`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await postOther(narratorBody(other.id, 0))).status).toBe(200);
    expect((await postOther(narratorBody(other.id, 500, "policyDecision"))).status).toBe(429);
  });

  it("marks the hourly cap and the spacing rule apart in the 429 body (D43)", async () => {
    const env = loadEnv({ CREW_DB: "memory", CREW_NARRATOR_MAX_CALLS_PER_HOUR: "2" });
    const { app } = buildTestApp({ env, runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);
    const post = (body: unknown) =>
      authed(app, token, `/api/games/${game.id}/narrator`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post(narratorBody(game.id, 0))).status).toBe(200);
    const spaced = await post(narratorBody(game.id, 40));
    expect(spaced.status).toBe(429);
    expect((await readJson(spaced)).error).toMatchObject({
      code: "budgetExceeded",
      reason: "spacing",
    });
    // The rejection does not count toward the cap of 2 (it never reached the model), so a
    // properly spaced call still goes through; the one after it hits the hourly rule.
    expect((await post(narratorBody(game.id, 500))).status).toBe(200);
    const capped = await post(narratorBody(game.id, 1000));
    expect(capped.status).toBe(429);
    expect((await readJson(capped)).error).toMatchObject({
      code: "budgetExceeded",
      reason: "hourly",
    });
  });

  describe("CREW_NARRATOR_FALLBACK=error (D43)", () => {
    const fallbackOutcome = (fallback: string, error: string): RunNarrator => {
      return async () => ({
        response: {
          commands: [],
          callId: "fallback-call",
          model: "null-narrator",
          promptVersion: "v0.8",
          fallback: fallback as "apiError",
          notesUpdate: TEST_NOTES,
        },
        error,
      });
    };
    const post = (
      app: ReturnType<typeof buildTestApp>["app"],
      token: string,
      gameId: string,
      tick = 0,
    ) =>
      authed(app, token, `/api/games/${gameId}/narrator`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(narratorBody(gameId, tick)),
      });

    it("503s notConfigured (not retryable) and logs the call as an error", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const env = loadEnv({ CREW_DB: "memory", CREW_NARRATOR_FALLBACK: "error" });
      const { app, db } = buildTestApp({
        env,
        runNarrator: fallbackOutcome("notConfigured", "no OPENROUTER_API_KEY configured"),
      });
      const { token } = await mintUser(app);
      const { game } = await createGame(app, token);

      const res = await post(app, token, game.id);
      expect(res.status).toBe(503);
      expect((await readJson(res)).error).toEqual({
        code: "narratorUnavailable",
        reason: "notConfigured",
        message: "no OPENROUTER_API_KEY configured",
        retryable: false,
      });
      const call = await db.getLastNarratorCall(game.id);
      expect(call?.status).toBe("error");
      expect(call?.error).toBe("notConfigured: no OPENROUTER_API_KEY configured");
      expect((await db.getGame(game.id))?.narrativeNotes).toEqual({});
    });

    it("502s a model failure with its reason, retryable, and does not space out the retry", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const env = loadEnv({
        CREW_DB: "memory",
        CREW_NARRATOR_FALLBACK: "error",
        CREW_NARRATOR_MAX_CALLS_PER_HOUR: "10",
      });
      let attempts = 0;
      const flaky: RunNarrator = async (req, ctx) => {
        attempts += 1;
        if (attempts < 3) {
          return fallbackOutcome("timeout", "narrator call timed out")(req, ctx);
        }
        return echoNarrator(req, ctx);
      };
      const { app, db } = buildTestApp({ env, runNarrator: flaky });
      const { token } = await mintUser(app);
      const { game } = await createGame(app, token);

      const first = await post(app, token, game.id, 300);
      expect(first.status).toBe(502);
      expect((await readJson(first)).error).toEqual({
        code: "narratorUnavailable",
        reason: "timeout",
        message: "narrator call timed out",
        retryable: true,
      });
      expect((await db.getLastNarratorCall(game.id))?.status).toBe("error");

      expect((await post(app, token, game.id, 300)).status).toBe(502);
      // Same hook, same tick: the failed attempts are not "the last call" for spacing.
      const third = await post(app, token, game.id, 300);
      expect(third.status).toBe(200);
      expect((await db.getLastNarratorCall(game.id))?.status).toBe("ok");
      expect(attempts).toBe(3);
    });

    it("serves the template fallback in null mode (the default outside production)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const env = loadEnv({ CREW_DB: "memory" });
      expect(env.narratorFallback).toBe("null");
      const { app, db } = buildTestApp({
        env,
        runNarrator: fallbackOutcome("apiError", "OpenRouter 500"),
      });
      const { token } = await mintUser(app);
      const { game } = await createGame(app, token);
      const res = await post(app, token, game.id);
      expect(res.status).toBe(200);
      expect((await readJson(res)).fallback).toBe("apiError");
      expect((await db.getLastNarratorCall(game.id))?.status).toBe("ok");
    });
  });

  it("400s an invalid narrator request", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: game.id, hook: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("round-trips structured notes through the jsonb column into the next call", async () => {
    const seen: unknown[] = [];
    const notes = {
      summary: "Took on core samples at the Drift.",
      threads: [
        {
          title: "Who is the assay clerk?",
          scale: "episode" as const,
          people: ["Ines Varga"],
          stage: "Ines was nervous at the handover.",
          nextBeat: "When the ship is next at the Drift, she asks a favour.",
          lastBeatTick: null,
          beatCardShown: false,
        },
      ],
      cardsShown: [],
      cast: [
        {
          name: "Ines Varga",
          note: "assay clerk, nervous",
          portId: "port.kessler_drift",
          lastSeenTick: 1800,
        },
      ],
      lastUpdatedTick: 0,
      lastRejections: ["offerJob: no route"],
    };
    const recording: RunNarrator = async (_req, ctx: NarratorCtx) => {
      seen.push(ctx.notes);
      return {
        response: {
          commands: [],
          callId: `call-${seen.length}`,
          model: "anthropic/claude-opus-4.6",
          promptVersion: "v0.1",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          notesUpdate: notes,
        },
      };
    };
    const { app, db } = buildTestApp({ runNarrator: recording });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);
    for (const tick of [0, 500]) {
      const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(narratorBody(game.id, tick)),
      });
      expect(res.status).toBe(200);
    }
    expect(seen[0]).toEqual({});
    expect(seen[1]).toEqual(notes);
    expect((await db.getGame(game.id))?.narrativeNotes).toEqual(notes);
    const call = await db.getLastNarratorCall(game.id);
    expect(call?.model).toBe("anthropic/claude-opus-4.6");
    expect(call?.promptVersion).toBe("v0.1");
    expect(call?.inputTokens).toBe(10);
  });

  it("accepts the real approaching-port fixture posted without gameId (it's already in the path)", async () => {
    // Regression test: the fixture's shape is `{gameId, hook, snapshot, recentEvents}`, but a
    // caller posting to `/api/games/:id/narrator` may reasonably omit `gameId` from the body
    // since it's already in the URL. The schema used to require it unconditionally, which 400'd
    // this exact, legitimate request in production.
    const fixturePath = fileURLToPath(
      new URL("../../../narrator/fixtures/approaching-port.json", import.meta.url),
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      gameId: string;
      hook: unknown;
      snapshot: unknown;
      recentEvents: unknown;
    };
    const { gameId: _fixtureGameId, ...bodyWithoutGameId } = fixture;

    const { app } = buildTestApp({ runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyWithoutGameId),
    });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.commands).toEqual([]);
  });

  it("returns the Zod issues as `details` in a 400 response", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: game.id, hook: {} }),
    });

    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });
});
