/**
 * §repair-turn: a reply that is empty, not JSON or fails its schema is handed back to the model in
 * the same conversation with what was wrong, a bounded number of times and only while the call's
 * time budget leaves room; every other failure, and running out, still fails the call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNarratorPlanSchema } from "./contract";
import { quietTooLongRequest, stageDockRequest } from "./fixtures";
import {
  FallbackError,
  MIN_REPAIR_MS,
  REPAIR_HEADING,
  ReplyFailedError,
  callForValidReply,
  issueLines,
  parseJsonReply,
} from "./model-call";
import { NULL_NARRATOR_MODEL } from "./null";
import { runNarratorWithTrace } from "./run";
import { FIXTURE_CALL_BACK, content, okResult } from "./test-support";
import type { ModelRequest, ModelResult, ModelTransport } from "./transport";

const VALID_PLAN = JSON.stringify({
  rationale: "Nothing yet.",
  intents: [],
  card: null,
  callBack: FIXTURE_CALL_BACK,
});
/** A plan missing `callBack`, which the schema requires. */
const PLAN_WITHOUT_CALL_BACK = JSON.stringify({ rationale: "x", intents: [], card: null });
const VALID_NOTES = JSON.stringify({
  summary: "Written on the second try.",
  threads: [],
  cast: [],
  retired: [],
  endedArcs: [],
});
const VALID_STAGING = JSON.stringify({ rationale: "a quiet dock", intents: [] });

/** A transport that answers each call with the next scripted reply and records the requests. */
function scripted(replies: readonly ModelResult[]): ModelTransport & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const transport = async (request: ModelRequest) => {
    calls.push(request);
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error(`no scripted reply for call ${calls.length}`);
    return reply;
  };
  return Object.assign(transport, { calls });
}

/** A JSON object that is not a plan: `parse` accepts only `{ ok: true }`. */
function parseOk(content: string): true {
  const json = parseJsonReply(content);
  if (json === null || typeof json !== "object" || !("ok" in json) || json.ok !== true) {
    throw new FallbackError("schemaInvalid", "not ok", ["at ok: expected true"]);
  }
  return true;
}

const CALL = {
  model: "test/model",
  system: ["rules"],
  user: "the ship right now",
  continuation: [],
  schemaName: "test",
  jsonSchema: {},
  maxTokens: 100,
  reasoningEffort: "default",
  timeoutMs: 25_000,
} as const;

const OPTIONS = { maxRepairs: 2, logContext: { gameId: "g1" } } as const;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("callForValidReply (§repair-turn)", () => {
  it("hands a reply that is not JSON back with what was wrong, and takes the fixed one", async () => {
    const transport = scripted([okResult("Sure! {ok: true}"), okResult('{"ok": true}')]);
    const reply = await callForValidReply(transport, CALL, parseOk, OPTIONS);
    expect(reply.value).toBe(true);
    expect(reply.content).toBe('{"ok": true}');
    expect(reply.repairs).toEqual([
      { attempt: 1, problems: [expect.stringContaining("Your reply was not valid JSON")] },
    ]);
    expect(transport.calls).toHaveLength(2);
    const [bad, ask] = transport.calls[1]?.continuation ?? [];
    expect(bad).toEqual({ role: "assistant", content: "Sure! {ok: true}", reasoningDetails: [] });
    expect(ask?.role).toBe("user");
    expect(ask?.content).toContain(REPAIR_HEADING);
    expect(ask?.content).toContain("not valid JSON");
    expect(ask?.content).toContain("complete corrected JSON object");
    // The cached prefix is untouched: same system and first user turn.
    expect(transport.calls[1]?.system).toEqual(CALL.system);
    expect(transport.calls[1]?.user).toBe(CALL.user);
  });

  it("logs each repair with its attempt number and the issues", async () => {
    const transport = scripted([okResult("nope"), okResult('{"ok": true}')]);
    await callForValidReply(transport, CALL, parseOk, OPTIONS);
    expect(warn).toHaveBeenCalledWith(
      "[narrator] repair",
      expect.objectContaining({
        gameId: "g1",
        attempt: 1,
        issues: expect.stringContaining("not valid JSON"),
      }),
    );
  });

  it("sums the usage of every attempt and ends the conversation with the accepted reply", async () => {
    const transport = scripted([
      { ...okResult('{"ok": false}'), reasoningDetails: [{ id: "r1" }] },
      { ...okResult('{"ok": true}'), reasoningDetails: [{ id: "r2" }] },
    ]);
    const reply = await callForValidReply(transport, CALL, parseOk, OPTIONS);
    expect(reply.usage.inputTokens).toBe(2 * okResult("").usage.inputTokens);
    expect(reply.usage.outputTokens).toBe(2 * okResult("").usage.outputTokens);
    // The bad reply went back with its own reasoning; the conversation keeps both.
    expect(transport.calls[1]?.continuation[0]).toMatchObject({ reasoningDetails: [{ id: "r1" }] });
    expect(reply.conversation).toEqual([
      { role: "assistant", content: '{"ok": false}', reasoningDetails: [{ id: "r1" }] },
      { role: "user", content: expect.stringContaining("at ok: expected true") },
      { role: "assistant", content: '{"ok": true}', reasoningDetails: [{ id: "r2" }] },
    ]);
  });

  it("repairs twice with maxRepairs 2, then succeeds", async () => {
    const transport = scripted([okResult("{"), okResult("[]"), okResult('{"ok": true}')]);
    const reply = await callForValidReply(transport, CALL, parseOk, OPTIONS);
    expect(reply.repairs.map((r) => r.attempt)).toEqual([1, 2]);
    // The second repair sees the whole conversation so far.
    expect(transport.calls[2]?.continuation.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("fails schemaInvalid once the repairs run out", async () => {
    const transport = scripted([okResult("{"), okResult("{"), okResult("{")]);
    const failed = callForValidReply(transport, CALL, parseOk, OPTIONS);
    await expect(failed).rejects.toBeInstanceOf(ReplyFailedError);
    await expect(failed).rejects.toMatchObject({
      reason: "schemaInvalid",
      rawContent: "{",
      message: expect.stringContaining("after 2 repairs"),
    });
    expect(transport.calls).toHaveLength(3);
  });

  it("never repairs with maxRepairs 0", async () => {
    const transport = scripted([okResult("{")]);
    await expect(
      callForValidReply(transport, CALL, parseOk, { ...OPTIONS, maxRepairs: 0 }),
    ).rejects.toMatchObject({ reason: "schemaInvalid", repairs: [] });
    expect(transport.calls).toHaveLength(1);
  });

  it("does not repair when too little of the call's budget is left", async () => {
    // Each attempt takes 15 s of a 25 s budget: 10 s are left, less than the attempt took.
    let clock = 0;
    const slow: ModelTransport = async () => {
      clock += 15_000;
      return okResult("{");
    };
    const transport = Object.assign(slow, { calls: [] as ModelRequest[] });
    await expect(
      callForValidReply(transport, CALL, parseOk, { ...OPTIONS, now: () => clock }),
    ).rejects.toMatchObject({
      reason: "schemaInvalid",
      repairs: [],
      message: expect.stringContaining("no time left to repair"),
    });
  });

  it("gives a repair only the time left in the call's budget", async () => {
    let clock = 0;
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const replies = [okResult("{"), okResult('{"ok": true}')];
    const transport: ModelTransport = async () => {
      clock += 5_000;
      return replies.shift() ?? okResult("");
    };
    await callForValidReply(transport, CALL, parseOk, { ...OPTIONS, now: () => clock });
    expect(timeouts.mock.calls).toEqual([[25_000], [20_000]]);
    timeouts.mockRestore();
  });

  it("does not repair below the floor even after a fast failure", async () => {
    const transport = scripted([okResult("{")]);
    await expect(
      callForValidReply(transport, { ...CALL, timeoutMs: MIN_REPAIR_MS - 1 }, parseOk, OPTIONS),
    ).rejects.toMatchObject({ reason: "schemaInvalid", repairs: [] });
    expect(transport.calls).toHaveLength(1);
  });

  it("asks again after an empty reply without sending the empty reply back", async () => {
    const transport = scripted([{ ...okResult(""), content: null }, okResult('{"ok": true}')]);
    const reply = await callForValidReply(transport, CALL, parseOk, OPTIONS);
    expect(reply.repairs[0]?.problems).toEqual(["Your reply was empty."]);
    const continuation = transport.calls[1]?.continuation ?? [];
    expect(continuation).toHaveLength(1);
    expect(continuation[0]).toMatchObject({ role: "user" });
    expect(continuation[0]?.content).toContain("Your reply was empty.");
  });

  it.each([
    ["truncated", { ...okResult("{"), finish: "length" as const }],
    ["refusal", { ...okResult(""), content: null, finish: "refusal" as const }],
  ])("does not repair a %s reply", async (reason, result) => {
    const transport = scripted([result]);
    await expect(callForValidReply(transport, CALL, parseOk, OPTIONS)).rejects.toMatchObject({
      reason,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("does not repair a provider error", async () => {
    const transport: ModelTransport = async () => {
      throw new Error("socket hang up");
    };
    await expect(callForValidReply(transport, CALL, parseOk, OPTIONS)).rejects.toMatchObject({
      reason: "apiError",
    });
  });
});

describe("issue lines for the repair request (§repair-turn)", () => {
  const schema = buildNarratorPlanSchema();
  const lines = (plan: unknown) => {
    const result = schema.safeParse(plan);
    if (result.success) throw new Error("expected the plan to fail");
    return issueLines(result.error.issues);
  };

  it("names an intent kind that does not exist and lists the kinds allowed", () => {
    const issues = lines({
      rationale: "",
      intents: [{ kind: "teleport" }],
      card: null,
      callBack: FIXTURE_CALL_BACK,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^at intents\.0\.kind: not one of the allowed values: .*"offerJob"/);
  });

  it("spells out the fields of the intent kind the model chose, not a bare 'Invalid input'", () => {
    const issues = lines({
      rationale: "",
      intents: [{ kind: "offerJob" }],
      card: null,
      callBack: FIXTURE_CALL_BACK,
    });
    expect(issues).toContain(
      "at intents.0.pitch: Invalid input: expected string, received undefined",
    );
    expect(issues.join("\n")).not.toContain("intents.0: Invalid input");
  });

  it("names a missing or unknown top-level key", () => {
    expect(lines({ rationale: "", intents: [], card: null, extra: 1 })).toEqual([
      expect.stringMatching(/^at callBack: /),
      'at (the whole reply): Unrecognized key: "extra"',
    ]);
  });
});

describe("the repair turn in the narrator calls (§repair-turn)", () => {
  const ctx = (transport: ModelTransport, extra: object = {}) => ({
    gameId: "g1",
    content: content(),
    callId: "call1",
    transport,
    ...extra,
  });

  it("answers a story call after one repair, and the second request carries the issue and the bad reply", async () => {
    const transport = scripted([
      okResult(PLAN_WITHOUT_CALL_BACK),
      okResult(VALID_PLAN),
      okResult(VALID_NOTES),
    ]);
    const run = await runNarratorWithTrace(quietTooLongRequest(content()), ctx(transport));
    expect(run.response.fallback).toBeUndefined();
    expect(run.repairs).toHaveLength(1);
    expect(run.repairs[0]?.problems.join("\n")).toContain("at callBack:");
    const [bad, ask] = transport.calls[1]?.continuation ?? [];
    expect(bad).toMatchObject({ role: "assistant", content: PLAN_WITHOUT_CALL_BACK });
    expect(ask?.content).toContain("at callBack:");
    // Usage counts both attempts.
    expect(run.response.usage?.inputTokens).toBe(2 * okResult("").usage.inputTokens);

    // §notes-turn: the notes turn continues the whole conversation, repair included.
    const notes = await run.notesTurn?.();
    expect(notes).toMatchObject({ ok: true, repairs: [] });
    const notesTurn = transport.calls[2]?.continuation ?? [];
    expect(notesTurn.map((m) => m.role)).toEqual(["assistant", "user", "assistant", "user"]);
    expect(notesTurn[2]).toMatchObject({ content: VALID_PLAN });
    expect(notesTurn[3]?.content).toContain("# Now your notes");
  });

  it("falls back schemaInvalid once a story call's repairs run out", async () => {
    const transport = scripted([
      okResult(PLAN_WITHOUT_CALL_BACK),
      okResult(PLAN_WITHOUT_CALL_BACK),
      okResult(PLAN_WITHOUT_CALL_BACK),
    ]);
    const run = await runNarratorWithTrace(quietTooLongRequest(content()), ctx(transport));
    expect(run.response).toMatchObject({ fallback: "schemaInvalid", model: NULL_NARRATOR_MODEL });
    expect(run.repairs).toHaveLength(2);
    expect(run.error).toContain("after 2 repairs");
    expect(run.trace.rawContent).toBe(PLAN_WITHOUT_CALL_BACK);
  });

  it("takes maxRepairs from the call's context", async () => {
    const transport = scripted([okResult(PLAN_WITHOUT_CALL_BACK), okResult(VALID_PLAN)]);
    const run = await runNarratorWithTrace(
      quietTooLongRequest(content()),
      ctx(transport, { maxRepairs: 0 }),
    );
    expect(run.response.fallback).toBe("schemaInvalid");
    expect(transport.calls).toHaveLength(1);
  });

  it("does not repair a story call whose budget is shorter than a repair needs", async () => {
    const transport = scripted([okResult(PLAN_WITHOUT_CALL_BACK), okResult(VALID_PLAN)]);
    const run = await runNarratorWithTrace(
      quietTooLongRequest(content()),
      ctx(transport, { timeoutMs: MIN_REPAIR_MS - 1 }),
    );
    expect(run.response.fallback).toBe("schemaInvalid");
    expect(run.repairs).toEqual([]);
    expect(transport.calls).toHaveLength(1);
  });

  it("repairs the notes turn's own reply", async () => {
    const transport = scripted([
      okResult(VALID_PLAN),
      okResult('{"summary": "no lists"}'),
      okResult(VALID_NOTES),
    ]);
    const run = await runNarratorWithTrace(quietTooLongRequest(content()), ctx(transport));
    expect(run.repairs).toEqual([]);
    const notes = await run.notesTurn?.();
    expect(notes).toMatchObject({ ok: true, repairs: [{ attempt: 1 }] });
    if (notes?.ok !== true) throw new Error("expected notes");
    expect(notes.notes.summary).toBe("Written on the second try.");
    const repairTurn = transport.calls[2]?.continuation ?? [];
    expect(repairTurn.map((m) => m.role)).toEqual(["assistant", "user", "assistant", "user"]);
    expect(repairTurn[2]).toMatchObject({ content: '{"summary": "no lists"}' });
    expect(repairTurn[3]?.content).toContain("at threads:");
  });

  it("reports a notes turn whose repairs ran out, with the repairs", async () => {
    const transport = scripted([
      okResult(VALID_PLAN),
      okResult("not json"),
      okResult("not json"),
      okResult("not json"),
    ]);
    const run = await runNarratorWithTrace(quietTooLongRequest(content()), ctx(transport));
    const notes = await run.notesTurn?.();
    expect(notes).toMatchObject({ ok: false, reason: "schemaInvalid", rawContent: "not json" });
    expect(notes?.repairs).toHaveLength(2);
  });

  it("repairs the staging call's reply", async () => {
    const transport = scripted([
      okResult(JSON.stringify({ rationale: "x", intents: [], notes: "staging writes none" })),
      okResult(VALID_STAGING),
    ]);
    const run = await runNarratorWithTrace(stageDockRequest(content()), ctx(transport));
    expect(run.response.fallback).toBeUndefined();
    expect(run.repairs).toHaveLength(1);
    expect(transport.calls[1]?.schemaName).toBe("staging_plan");
    expect(transport.calls[1]?.continuation[1]?.content).toContain('Unrecognized key: "notes"');
  });
});
