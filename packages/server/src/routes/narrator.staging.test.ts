/**
 * D67: the staging call through the route: its own model, its own budget, outside the story
 * spacing rule both ways, logged by kind, never writing notes, and falling back to the floor set
 * without an error panel.
 */
import { loadBundle } from "@crew/content";
import {
  type ModelTransport,
  TransportError,
  runNarratorWithTrace,
  stageDockRequest,
} from "@crew/narrator";
import type { ContentBundle } from "@crew/sim";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env";
import type { NarratorCtx, RunNarrator } from "../narrator";
import { TEST_NOTES, buildTestApp, echoNarrator, mintUser, readJson } from "../test-helpers";

let bundle: ContentBundle | undefined;
function content(): ContentBundle {
  if (bundle === undefined) {
    const result = loadBundle();
    if (!result.ok) throw new Error("content failed validation");
    bundle = result.bundle;
  }
  return bundle;
}

type App = ReturnType<typeof buildTestApp>["app"];

async function setup(
  env = loadEnv({ CREW_DB: "memory" }),
  runNarrator: RunNarrator = echoNarrator,
) {
  const { app, db } = buildTestApp({ env, runNarrator });
  const { token } = await mintUser(app);
  const res = await app.request("/api/games", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Freighter Run" }),
  });
  const { game } = (await res.json()) as { game: { id: string } };
  const post = (body: unknown) =>
    app.request(`/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return { app: app as App, db, gameId: game.id, post };
}

/** The real staging fixture, re-stamped at `tick` so spacing can be tested against it. */
function stagingBody(gameId: string, tick: number) {
  const req = stageDockRequest(content());
  return { ...req, gameId, snapshot: { ...req.snapshot, savedAtTick: tick } };
}

function storyBody(gameId: string, tick: number) {
  const req = stageDockRequest(content());
  return {
    gameId,
    hook: { kind: "quietTooLong", id: "h9", tick, context: { quietSinceTick: 0 } },
    snapshot: { ...req.snapshot, savedAtTick: tick },
    recentEvents: [],
  };
}

/** The real narrator over a fake transport (never the network). */
function realNarrator(transport: ModelTransport, seen: NarratorCtx[] = []): RunNarrator {
  return async (req, ctx) => {
    seen.push(ctx);
    const run = await runNarratorWithTrace(req, {
      gameId: ctx.gameId,
      notes: ctx.notes,
      transport,
      content: content(),
      ...(ctx.model === undefined ? {} : { model: ctx.model }),
      ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
    });
    return { response: run.response, ...(run.error === undefined ? {} : { error: run.error }) };
  };
}

const failing: ModelTransport = async () => {
  throw new TransportError("apiError", "OpenRouter 502: upstream overloaded");
};

const staged: ModelTransport = async (request) => ({
  model: request.model,
  content: JSON.stringify({
    rationale: "Greta at her board, and one line of colour.",
    intents: [
      {
        kind: "placePerson",
        who: "seed",
        name: "Greta Lindholm",
        role: "",
        look: "",
        post: "shift_board",
        label: "chalking up the next shift",
      },
      { kind: "setAmbience", line: "The ore conveyor clanks to a stop as the ship comes in." },
    ],
  }),
  finish: "stop",
  usage: {
    inputTokens: 900,
    outputTokens: 120,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
});

describe("POST /api/games/:id/narrator, stageDock (D67)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the staging call on the staging model and logs it as a stageDock call", async () => {
    const env = loadEnv({
      CREW_DB: "memory",
      CREW_NARRATOR_MODEL: "story/model",
      CREW_STAGING_MODEL: "cheap/model",
    });
    const seen: NarratorCtx[] = [];
    const { db, gameId, post } = await setup(env, realNarrator(staged, seen));
    const res = await post(stagingBody(gameId, 1600));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.commands.map((c: { kind: string }) => c.kind)).toEqual(["stageDock"]);
    expect(body.notesUpdate).toBeUndefined();
    expect(seen[0]?.model).toBe("cheap/model");

    const [call] = await db.listNarratorCalls({ gameId, kind: "staging", limit: 5 });
    expect(call).toMatchObject({
      hookKind: "stageDock",
      status: "ok",
      model: "cheap/model",
      inputTokens: 900,
      outputTokens: 120,
    });
    expect(call?.promptVersion).toMatch(/^v0\.\d+$/);
    expect(await db.listNarratorCalls({ gameId, kind: "story", limit: 5 })).toEqual([]);
  });

  it("never writes notes, even when a narrator hands some back", async () => {
    const { db, gameId, post } = await setup(undefined, echoNarrator);
    expect((await post(stagingBody(gameId, 1600))).status).toBe(200);
    expect((await db.getGame(gameId))?.narrativeNotes).toEqual({});
    // A story call does write them.
    expect((await post(storyBody(gameId, 2000))).status).toBe(200);
    expect((await db.getGame(gameId))?.narrativeNotes).toEqual(TEST_NOTES);
  });

  it("is outside the story spacing rule both ways", async () => {
    const { gameId, post } = await setup(
      loadEnv({ CREW_DB: "memory", CREW_NARRATOR_MAX_CALLS_PER_HOUR: "10" }),
    );
    expect((await post(storyBody(gameId, 1000))).status).toBe(200);
    // Ten ticks after a story call: a staging call is never "too soon"...
    expect((await post(stagingBody(gameId, 1010))).status).toBe(200);
    // ...and the next story call is spaced from the last story call, not from the staging one.
    expect((await post(storyBody(gameId, 1100))).status).toBe(200);
    // The story rule itself still holds.
    const tooSoon = await post(storyBody(gameId, 1150));
    expect(tooSoon.status).toBe(429);
    expect((await readJson(tooSoon)).error.reason).toBe("spacing");
  });

  it("has its own hourly budget: staging calls never use up the story's", async () => {
    const { gameId, post } = await setup(
      loadEnv({ CREW_DB: "memory", CREW_NARRATOR_MAX_CALLS_PER_HOUR: "1" }),
    );
    expect((await post(stagingBody(gameId, 1000))).status).toBe(200);
    const second = await post(stagingBody(gameId, 3000));
    expect(second.status).toBe(429);
    expect((await readJson(second)).error.reason).toBe("hourly");
    expect((await post(storyBody(gameId, 4000))).status).toBe(200);
  });

  it("null mode: a failing model falls back to the floor set, logged, with no error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, gameId, post } = await setup(
      loadEnv({ CREW_DB: "memory", CREW_NARRATOR_FALLBACK: "null" }),
      realNarrator(failing),
    );
    const res = await post(stagingBody(gameId, 1600));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ commands: [], fallback: "apiError" });
    expect(body.notesUpdate).toBeUndefined();
    const lines = warn.mock.calls.map((call) => call[0]);
    expect(lines).toContain("[narrator] staging fallback apiError");
    expect(lines).not.toContain("[narrator] fallback");
    const logged = warn.mock.calls.find((c) => c[0] === "[narrator] staging fallback apiError");
    expect(logged?.[1]).toMatchObject({ gameId, error: "OpenRouter 502: upstream overloaded" });
    expect(await db.getLastNarratorCall(gameId)).toMatchObject({
      hookKind: "stageDock",
      status: "ok",
    });
  });

  it("error mode: a failing model is a retryable 502 like a story call, so the client retries first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, gameId, post } = await setup(
      loadEnv({ CREW_DB: "memory", CREW_NARRATOR_FALLBACK: "error" }),
      realNarrator(failing),
    );
    const res = await post(stagingBody(gameId, 1600));
    expect(res.status).toBe(502);
    expect((await readJson(res)).error).toMatchObject({
      code: "narratorUnavailable",
      reason: "apiError",
      retryable: true,
    });
    expect(await db.getLastNarratorCall(gameId)).toMatchObject({
      hookKind: "stageDock",
      status: "error",
    });
  });

  it("gives a staging attempt CREW_STAGING_TIMEOUT_MS, not the story call's 25 s (D70)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hang: ModelTransport = (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    const seen: NarratorCtx[] = [];
    const { db, gameId, post } = await setup(
      loadEnv({
        CREW_DB: "memory",
        CREW_NARRATOR_FALLBACK: "error",
        CREW_STAGING_TIMEOUT_MS: "50",
      }),
      realNarrator(hang, seen),
    );
    const started = Date.now();
    const res = await post(stagingBody(gameId, 1600));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen[0]?.timeoutMs).toBe(50);
    expect(res.status).toBe(502);
    expect((await readJson(res)).error).toMatchObject({ reason: "timeout", retryable: true });
    expect(await db.getLastNarratorCall(gameId)).toMatchObject({
      hookKind: "stageDock",
      status: "error",
    });
  });

  it("gives a story call no staging timeout: it keeps the narrator's own (D70)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: NarratorCtx[] = [];
    const { gameId, post } = await setup(
      loadEnv({ CREW_DB: "memory", CREW_STAGING_TIMEOUT_MS: "50" }),
      realNarrator(staged, seen),
    );
    await post(storyBody(gameId, 5000));
    expect(seen[0]?.timeoutMs).toBeUndefined();
  });
});
