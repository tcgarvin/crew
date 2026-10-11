/**
 * §notes-turn: the notes turn through the route. The real narrator over a fake transport (never the
 * network) answers a story call with a plan; the route stores the notes as they stand, logs a
 * `notes` row, runs the notes turn (inline here: there is no Vercel request context) and stores
 * the model's notes. A call that arrives while a notes turn is pending waits for it.
 */
import { loadBundle } from "@crew/content";
import {
  KEEP_PLAN,
  type ModelTransport,
  type NarratorNotes,
  parseNotes,
  quietTooLongRequest,
  runNarratorWithTrace,
} from "@crew/narrator";
import type { ContentBundle } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { NOTES_HOOK_KIND } from "../db/types";
import { loadEnv } from "../env";
import type { RunNarrator } from "../narrator";
import { buildTestApp, createGame, mintUser, sendJson } from "../test-helpers";

let bundle: ContentBundle | undefined;
function content(): ContentBundle {
  if (bundle === undefined) {
    const result = loadBundle();
    if (!result.ok) throw new Error("content failed validation");
    bundle = result.bundle;
  }
  return bundle;
}

// §requested-call-back: every plan the model writes carries its call-back request.
const PLAN = {
  rationale: "Nothing yet.",
  intents: [],
  card: null,
  callBack: { when: "nextPort", why: "" },
};
const WRITTEN = {
  summary: "A quiet leg, written after the plan.",
  threads: [],
  cast: [],
  retired: [],
  endedArcs: [],
  plan: KEEP_PLAN,
};

/** The plan turn gets `PLAN`; the notes turn (the one with a continuation) gets `notesReply`. */
function twoTurns(notesReply: string): ModelTransport {
  return async (request) => ({
    model: request.model,
    content: request.continuation.length > 0 ? notesReply : JSON.stringify(PLAN),
    finish: "stop",
    usage: {
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    reasoningDetails: [],
    toolCalls: [],
  });
}

/** The real narrator, recording the notes each call was handed. */
function realNarrator(transport: ModelTransport, notesSeen: unknown[] = []): RunNarrator {
  return async (req, ctx) => {
    notesSeen.push(ctx.notes);
    const run = await runNarratorWithTrace(req, {
      gameId: ctx.gameId,
      notes: ctx.notes,
      transport,
      content: content(),
    });
    return {
      response: run.response,
      ...(run.error === undefined ? {} : { error: run.error }),
      ...(run.notesTurn === undefined ? {} : { notesTurn: run.notesTurn }),
      ...(run.repairs.length === 0 ? {} : { repairs: run.repairs }),
    };
  };
}

async function setUp(runNarrator: RunNarrator) {
  const env = loadEnv({ CREW_DB: "memory" });
  const { app, db } = buildTestApp({ env, runNarrator });
  const { token } = await mintUser(app);
  const { game } = await createGame(app, token);
  const post = (body: object) =>
    sendJson(app, token, "POST", `/api/games/${game.id}/narrator`, { ...body, gameId: game.id });
  return { db, gameId: game.id, post };
}

describe("POST /api/games/:id/narrator, the notes turn (§notes-turn)", () => {
  it("stores the model's notes and logs the notes turn as its own ok row", async () => {
    const { db, gameId, post } = await setUp(realNarrator(twoTurns(JSON.stringify(WRITTEN))));
    const res = await post(quietTooLongRequest(content()));
    expect(res.status).toBe(200);
    const game = await db.getGame(gameId);
    expect(parseNotes(game?.narrativeNotes).summary).toBe(WRITTEN.summary);
    const [notesRow] = await db.listNarratorCalls({ gameId, hookKind: NOTES_HOOK_KIND, limit: 5 });
    expect(notesRow?.status).toBe("ok");
    expect(notesRow?.outputTokens).toBe(50);
    expect((notesRow?.response as { notes: NarratorNotes }).notes.summary).toBe(WRITTEN.summary);
    // Not a story call: one story row, not two.
    expect(await db.listNarratorCalls({ gameId, kind: "story", limit: 5 })).toHaveLength(1);
  });

  it("records the notes turn's tool calls in its logged response (§notes-turn-tools)", async () => {
    const answer = twoTurns(JSON.stringify(WRITTEN));
    const withTool: ModelTransport = async (request) => {
      const reply = await answer(request);
      const callable = request.tools.kind === "offered" && request.tools.choice === "auto";
      const asked = request.continuation.some((m) => m.role === "toolRequest");
      if (!callable || asked) return reply;
      const toolCalls = [{ id: "t1", name: "thread", arguments: '{"title":"Nobody"}' }];
      return { ...reply, content: null, finish: "toolCalls", toolCalls };
    };
    const { db, gameId, post } = await setUp(realNarrator(withTool));
    expect((await post(quietTooLongRequest(content()))).status).toBe(200);
    const [notesRow] = await db.listNarratorCalls({ gameId, hookKind: NOTES_HOOK_KIND, limit: 5 });
    expect(notesRow?.status).toBe("ok");
    expect((notesRow?.response as { toolCalls: unknown[] }).toolCalls).toEqual([
      expect.objectContaining({
        round: 1,
        name: "thread",
        result: expect.stringMatching(/^No such thread/),
      }),
    ]);
    const game = await db.getGame(gameId);
    expect(parseNotes(game?.narrativeNotes).summary).toBe(WRITTEN.summary);
  });

  it("keeps the plan's notes and logs an error row when the notes turn fails", async () => {
    const { db, gameId, post } = await setUp(realNarrator(twoTurns("not json")));
    const res = await post(quietTooLongRequest(content()));
    expect(res.status).toBe(200);
    const [notesRow] = await db.listNarratorCalls({ gameId, hookKind: NOTES_HOOK_KIND, limit: 5 });
    expect(notesRow?.status).toBe("error");
    expect(notesRow?.error).toContain("schemaInvalid");
    // §repair-turn: the notes reply was handed back twice before the turn gave up.
    expect((notesRow?.response as { repairs: unknown[] }).repairs).toHaveLength(2);
    const game = await db.getGame(gameId);
    expect(game?.narrativeNotes).not.toBeNull();
    expect(parseNotes(game?.narrativeNotes).summary).not.toBe(WRITTEN.summary);
  });

  it("records the story call's repairs in its logged response, not in the reply (§repair-turn)", async () => {
    let planCalls = 0;
    const transport: ModelTransport = async (request) => {
      const notesTurn =
        request.continuation.at(-1)?.content.startsWith("# Now your notes") === true;
      if (!notesTurn) planCalls += 1;
      const plan = planCalls === 1 ? "{" : JSON.stringify(PLAN);
      return {
        model: request.model,
        content: notesTurn ? JSON.stringify(WRITTEN) : plan,
        finish: "stop",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        reasoningDetails: [],
        toolCalls: [],
      };
    };
    const { db, gameId, post } = await setUp(realNarrator(transport));
    const res = await post(quietTooLongRequest(content()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.repairs).toBeUndefined();
    const [storyRow] = await db.listNarratorCalls({ gameId, kind: "story", limit: 1 });
    expect(storyRow?.status).toBe("ok");
    expect((storyRow?.response as { repairs: unknown[] }).repairs).toEqual([
      { attempt: 1, problems: [expect.stringContaining("not valid JSON")] },
    ]);
  });

  it("waits for a pending notes turn and hands the call the notes it wrote", async () => {
    const notesSeen: unknown[] = [];
    const { db, gameId, post } = await setUp(
      realNarrator(twoTurns(JSON.stringify(WRITTEN)), notesSeen),
    );
    const save = await db.getHeadSave(gameId);
    const basis =
      save ??
      (await db.putSave({
        gameId,
        blob: Buffer.from(""),
        schemaVersion: 1,
        simVersion: "0",
        contentHash: "h",
        savedAtTick: 0,
        isMilestone: true,
      }));
    const pending = await db.logNarratorCall({
      gameId,
      hookKind: NOTES_HOOK_KIND,
      basisSaveId: basis.id,
      model: "m",
      promptVersion: "v",
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      status: "pending",
      request: {},
      response: null,
      error: null,
    });
    const earlier = { ...parseNotes(undefined), summary: "Written by the earlier notes turn." };
    setTimeout(() => {
      void db.updateNotes(gameId, earlier).then(() =>
        db.finishNarratorCall(pending.id, {
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 700,
          status: "ok",
          response: { notes: earlier },
          error: null,
        }),
      );
    }, 700);
    const res = await post(quietTooLongRequest(content()));
    expect(res.status).toBe(200);
    expect(parseNotes(notesSeen[0]).summary).toBe("Written by the earlier notes turn.");
  });

  it("refuses a request whose hook kind is notes", async () => {
    const { post } = await setUp(realNarrator(twoTurns(JSON.stringify(WRITTEN))));
    const req = quietTooLongRequest(content());
    const res = await post({ ...req, hook: { ...req.hook, kind: NOTES_HOOK_KIND } });
    expect(res.status).toBe(400);
  });
});
