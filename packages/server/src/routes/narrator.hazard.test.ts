/**
 * §debris-fields-and-ion-storms: the sixth lever through the route. The real narrator over a fake
 * transport (never the network) answers an in-transit check-in with a `scheduleHazard`; the client
 * gets the kernel command, tier turned into the config difficulty, and the call log keeps it.
 */
import { loadBundle } from "@crew/content";
import { type ModelTransport, quietTooLongRequest, runNarratorWithTrace } from "@crew/narrator";
import type { ContentBundle } from "@crew/sim";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env";
import type { RunNarrator } from "../narrator";
import { buildTestApp, createGame, mintUser, readJson, sendJson } from "../test-helpers";

let bundle: ContentBundle | undefined;
function content(): ContentBundle {
  if (bundle === undefined) {
    const result = loadBundle();
    if (!result.ok) throw new Error("content failed validation");
    bundle = result.bundle;
  }
  return bundle;
}

function planWith(intents: unknown[]): ModelTransport {
  // §notes-turn: the plan turn, then the notes turn (the one with a continuation).
  return async (request) => ({
    model: request.model,
    content: JSON.stringify(
      request.continuation.length > 0
        ? { summary: "Quiet run to Green Meridian.", threads: [], cast: [] }
        : {
            rationale: "A long quiet leg and the junior at the helm: put something in her path.",
            intents,
            card: null,
            // §requested-call-back: every plan the model writes carries its call-back request.
            callBack: { when: "nextPort", why: "" },
          },
    ),
    finish: "stop",
    usage: {
      inputTokens: 1000,
      outputTokens: 80,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    reasoningDetails: [],
  });
}

function realNarrator(transport: ModelTransport): RunNarrator {
  return async (req, ctx) => {
    const run = await runNarratorWithTrace(req, {
      gameId: ctx.gameId,
      notes: ctx.notes,
      transport,
      content: content(),
    });
    return { response: run.response, ...(run.error === undefined ? {} : { error: run.error }) };
  };
}

async function post(transport: ModelTransport) {
  const { app, db } = buildTestApp({
    env: loadEnv({ CREW_DB: "memory" }),
    runNarrator: realNarrator(transport),
  });
  const { token } = await mintUser(app);
  const { game } = await createGame(app, token);
  const req = quietTooLongRequest(content());
  const res = await sendJson(app, token, "POST", `/api/games/${game.id}/narrator`, {
    ...req,
    gameId: game.id,
  });
  return { res, db, gameId: game.id };
}

describe("POST /api/games/:id/narrator, scheduleHazard (§debris-fields-and-ion-storms)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a translated scheduleHazard and logs it with the call", async () => {
    const { res, db, gameId } = await post(
      planWith([
        {
          kind: "scheduleHazard",
          hazard: "debrisField",
          difficulty: "hard",
          window: "soon",
          outcome: "",
        },
      ]),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.fallback).toBeUndefined();
    expect(body.dropped).toEqual([]);
    expect(body.commands).toHaveLength(2);
    expect(body.commands[1]).toMatchObject({ kind: "requestCall" });
    expect(body.commands[0]).toMatchObject({
      kind: "scheduleHazard",
      source: "narrator",
      payload: { kind: "debrisField", difficulty: content().config.hazards.difficulty.hard },
    });
    const call = await db.getLastNarratorCall(gameId);
    expect(call?.status).toBe("ok");
    expect(JSON.stringify(call?.response)).toContain('"scheduleHazard"');
  });

  it("reports a hazard the translator drops, with its reason (one hazard waits at a time)", async () => {
    const hazard = {
      kind: "scheduleHazard",
      hazard: "ionStorm",
      difficulty: "brutal",
      window: "soon",
      outcome: "",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res } = await post(planWith([hazard, { ...hazard, hazard: "debrisField" }]));
    expect(warn).toHaveBeenCalledWith("[narrator] dropped", expect.anything());
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.fallback).toBeUndefined();
    expect(body.commands.map((c: { kind: string }) => c.kind)).toEqual([
      "scheduleHazard",
      "requestCall",
    ]);
    expect(body.dropped).toEqual([
      {
        intentIndex: 1,
        kind: "scheduleHazard",
        reason: "scheduleHazard: a hazard is already waiting on the ship's path; let it fire first",
      },
    ]);
  });
});
