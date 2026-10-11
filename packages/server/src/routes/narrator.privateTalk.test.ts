/**
 * §private-talk-effect: `privateTalk`, a card side effect, through the route. The real narrator
 * over a fake transport (never the network) answers a check-in with a card whose side calls a crew
 * member to the captain's cabin; the client gets the card with the player command on that side.
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

/** §tried-sides: a side that is not a try, as the model writes it. */
const NO_TRY = { odds: "", failEffect: "none", failLevers: [] } as const;

function cardCallingIn(talkWith: string): ModelTransport {
  const card = {
    kind: "surfaceDecision",
    beat: "",
    title: "Words at the card table",
    speaker: "Dane Whitcross",
    situation:
      "Dane stops the captain in the corridor. “Jax and Tomas are at it again over the cards, Captain. Someone should have a word.”",
    left: {
      label: "Send Jax up.",
      effect: "privateTalk",
      coursePort: "",
      talkWith,
      tone: "stern",
      ...NO_TRY,
    },
    right: {
      label: "Let it go.",
      effect: "none",
      coursePort: "",
      talkWith: "",
      tone: "",
      ...NO_TRY,
    },
    leftAftermath: "Dane goes to fetch Jax.",
    rightAftermath: "Dane shrugs and goes back to his station.",
    leftFailAftermath: "",
    rightFailAftermath: "",
    beatOfThread: "",
    closesThread: "",
    followUps: [],
  };
  // §notes-turn: the plan turn, then the notes turn (the one with a continuation).
  return async (request) => ({
    model: request.model,
    content: JSON.stringify(
      request.continuation.length > 0
        ? { summary: "Jax keeps beating Tomas at cards.", threads: [], cast: [] }
        : {
            rationale: "The rivalry at the card table is souring; give the captain the call.",
            intents: [card],
            card: null,
            // §requested-call-back: every plan the model writes carries its call-back request.
            callBack: { when: "nextPort", why: "", holdQuiet: false },
          },
    ),
    finish: "stop",
    usage: {
      inputTokens: 1000,
      outputTokens: 120,
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
  const { app } = buildTestApp({
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
  return { res, req };
}

describe("POST /api/games/:id/narrator, a privateTalk side (§private-talk-effect)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the card with privateTalk as the player command on its side", async () => {
    const { res, req } = await post(cardCallingIn("Jax Okonkwo"));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.fallback).toBeUndefined();
    expect(body.dropped).toEqual([]);
    const jax = Object.values(req.snapshot.state.actors).find((a) => a.name === "Jax Okonkwo");
    expect(body.commands).toHaveLength(2);
    expect(body.commands[1]).toMatchObject({ kind: "requestCall" });
    expect(body.commands[0]).toMatchObject({
      kind: "surfaceDecision",
      source: "narrator",
      payload: {
        card: {
          left: {
            commands: [{ kind: "privateTalk", payload: { actorId: jax?.id, tone: "stern" } }],
          },
          right: { commands: [] },
        },
      },
    });
  });

  it("drops the card when its side would call in the captain, with the reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res } = await post(cardCallingIn("Mara Osei"));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.commands.map((c: { kind: string }) => c.kind)).toEqual(["requestCall"]);
    expect(body.dropped).toEqual([
      {
        intentIndex: 0,
        kind: "surfaceDecision",
        reason: "surfaceDecision: left: Mara Osei is the captain, who does the calling in",
      },
    ]);
  });
});
