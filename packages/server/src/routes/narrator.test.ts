import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../env";
import type { NarratorCtx, RunNarrator } from "../narrator";
import { buildTestApp, echoNarrator, fakeEnvelope, mintUser, readJson } from "../test-helpers";

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

function narratorBody(gameId: string, savedAtTick = 0) {
  return {
    gameId,
    hook: { kind: "approachingPort" },
    snapshot: fakeEnvelope({ savedAtTick }),
    recentEvents: [],
  };
}

describe("narrator", () => {
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
