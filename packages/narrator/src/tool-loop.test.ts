/**
 * §notes-turn-tools: the tool loop inside `callForValidReply`: the model's tool calls are run and it
 * is called again, a bounded number of rounds and only while the budget leaves room for the answer;
 * the reply after them is validated and repaired as any other; a provider that refuses tools is
 * asked again without them. And the notes turn in `runNarratorWithTrace` offers the notes tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietTooLongRequest } from "./fixtures";
import {
  FallbackError,
  MAX_TOOL_CALLS_PER_ROUND,
  MAX_TOOL_RESULT_CHARS,
  NO_TOOL_LOOP,
  REPAIR_HEADING,
  ReplyFailedError,
  TOOLS_CLOSED_HEADING,
  TOOL_RESERVE_MS,
  type ToolLoop,
  callForValidReply,
  parseJsonReply,
} from "./model-call";
import { NOTES_TOOLS_LINE, runNarratorWithTrace } from "./run";
import { KEEP_PLAN } from "./story-plan";
import { FIXTURE_CALL_BACK, content, okResult } from "./test-support";
import {
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type ToolCall,
  ToolsRejectedError,
} from "./transport";

/** A transport that answers each call by `answer` and records the requests. */
function recording(
  answer: (request: ModelRequest, n: number) => ModelResult,
): ModelTransport & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const transport = async (request: ModelRequest) => {
    calls.push(request);
    return answer(request, calls.length);
  };
  return Object.assign(transport, { calls });
}

/** Each call answered with the next scripted reply. */
function scripted(replies: readonly ModelResult[]) {
  return recording((_request, n) => {
    const reply = replies[n - 1];
    if (reply === undefined) throw new Error(`no scripted reply for call ${n}`);
    return reply;
  });
}

function toolReply(calls: readonly ToolCall[], reasoningDetails: unknown[] = []): ModelResult {
  return {
    ...okResult(""),
    content: null,
    finish: "toolCalls",
    toolCalls: calls,
    reasoningDetails,
  };
}

const echoCall = (id: string, args = '{"say":"hi"}'): ToolCall => ({
  id,
  name: "echo",
  arguments: args,
});

/** A loop with one tool, `echo`, that answers with its arguments. */
function echoLoop(
  maxRounds = 4,
  run = (name: string, args: string) => `${name}: ${args}`,
): ToolLoop {
  return {
    kind: "loop",
    tools: [{ name: "echo", description: "says it back", parameters: { type: "object" } }],
    run,
    maxRounds,
  };
}

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
  continuation: [{ role: "user", content: "now your notes" }],
  schemaName: "test",
  jsonSchema: {},
  maxTokens: 100,
  reasoningEffort: "default",
  timeoutMs: 45_000,
} as const;

const OK = okResult('{"ok": true}');
const options = (tools: ToolLoop, extra: object = {}) => ({
  maxRepairs: 2,
  logContext: { gameId: "g1" },
  tools,
  ...extra,
});

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

describe("the tool loop (§notes-turn-tools)", () => {
  it("runs the model's tool calls, hands back the results with its reasoning, and takes the answer after", async () => {
    const reasoning = [{ id: "r1" }];
    const transport = scripted([toolReply([echoCall("c1")], reasoning), OK]);
    const reply = await callForValidReply(transport, CALL, parseOk, options(echoLoop()));
    expect(reply.value).toBe(true);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.tools).toMatchObject({ kind: "offered", choice: "auto" });
    expect(transport.calls[1]?.continuation.slice(1)).toEqual([
      {
        role: "toolRequest",
        content: "",
        reasoningDetails: reasoning,
        toolCalls: [echoCall("c1")],
      },
      { role: "toolResult", toolCallId: "c1", content: 'echo: {"say":"hi"}' },
    ]);
    expect(reply.toolCalls).toEqual([
      {
        round: 1,
        name: "echo",
        arguments: '{"say":"hi"}',
        resultChars: 18,
        result: 'echo: {"say":"hi"}',
      },
    ]);
    // The conversation a later turn continues keeps the tool turns, then the answer.
    expect(reply.conversation.map((m) => m.role)).toEqual([
      "user",
      "toolRequest",
      "toolResult",
      "assistant",
    ]);
    expect(reply.usage.inputTokens).toBe(2 * OK.usage.inputTokens);
    expect(info).toHaveBeenCalledWith(
      "[narrator] tool",
      expect.objectContaining({ gameId: "g1", round: 1, name: "echo", chars: 18 }),
    );
  });

  it("stops offering tools after the last round and asks for the answer", async () => {
    const transport = recording((request) =>
      request.tools.kind === "offered" && request.tools.choice === "auto"
        ? toolReply([echoCall(`c${request.continuation.length}`)])
        : OK,
    );
    const reply = await callForValidReply(transport, CALL, parseOk, options(echoLoop(2)));
    expect(reply.toolCalls.map((c) => c.round)).toEqual([1, 2]);
    expect(transport.calls).toHaveLength(3);
    const last = transport.calls[2];
    // Still declared, so the conversation's tool calls stay valid, but not callable.
    expect(last?.tools).toMatchObject({ kind: "offered", choice: "none" });
    expect(last?.continuation.at(-1)?.content).toMatch(
      new RegExp(`^${TOOLS_CLOSED_HEADING}\\n\\nThat was the last round of tool calls\\.`),
    );
    expect(info).toHaveBeenCalledWith(
      "[narrator] tools closed",
      expect.objectContaining({ why: "rounds", rounds: 2 }),
    );
  });

  it("stops offering tools when the budget left is less than the answer needs", async () => {
    let clock = 0;
    const transport = recording((request) => {
      if (request.tools.kind === "offered" && request.tools.choice === "auto") {
        clock += 45_000 - TOOL_RESERVE_MS + 1;
        return toolReply([echoCall("c1")]);
      }
      return OK;
    });
    const reply = await callForValidReply(
      transport,
      CALL,
      parseOk,
      options(echoLoop(4), { now: () => clock }),
    );
    expect(reply.toolCalls).toHaveLength(1);
    expect(transport.calls[1]?.tools).toMatchObject({ choice: "none" });
    expect(transport.calls[1]?.continuation.at(-1)?.content).toContain("Time is short.");
  });

  it("offers no tools at all when too little time is left from the start, and adds no closing turn", async () => {
    const transport = scripted([OK]);
    await callForValidReply(
      transport,
      { ...CALL, timeoutMs: TOOL_RESERVE_MS - 1 },
      parseOk,
      options(echoLoop()),
    );
    expect(transport.calls[0]?.tools).toMatchObject({ kind: "offered", choice: "none" });
    expect(transport.calls[0]?.continuation).toEqual(CALL.continuation);
  });

  it("repairs a malformed answer after tools, keeping the tool turns and offering no more tools", async () => {
    const transport = scripted([toolReply([echoCall("c1")]), okResult("not json"), OK]);
    const reply = await callForValidReply(transport, CALL, parseOk, options(echoLoop()));
    expect(reply.repairs).toHaveLength(1);
    expect(reply.toolCalls).toHaveLength(1);
    const repair = transport.calls[2];
    expect(repair?.tools).toMatchObject({ kind: "offered", choice: "none" });
    expect(repair?.continuation.map((m) => m.role)).toEqual([
      "user",
      "toolRequest",
      "toolResult",
      "assistant",
      "user",
    ]);
    expect(repair?.continuation.at(-1)?.content).toContain(REPAIR_HEADING);
  });

  it("reports the tool calls made when the call fails", async () => {
    const transport = scripted([toolReply([echoCall("c1")]), okResult("not json")]);
    const failed = callForValidReply(
      transport,
      CALL,
      parseOk,
      options(echoLoop(), { maxRepairs: 0 }),
    );
    await expect(failed).rejects.toBeInstanceOf(ReplyFailedError);
    await expect(failed).rejects.toMatchObject({
      reason: "schemaInvalid",
      toolCalls: [expect.objectContaining({ name: "echo" })],
    });
  });

  it("asks again without tools when the provider rejects them, and logs it", async () => {
    const transport = recording((request) => {
      if (request.tools.kind === "offered") {
        throw new ToolsRejectedError("OpenRouter 404: No endpoints found that support tool use");
      }
      return OK;
    });
    const reply = await callForValidReply(transport, CALL, parseOk, options(echoLoop()));
    expect(reply.value).toBe(true);
    expect(transport.calls.map((c) => c.tools.kind)).toEqual(["offered", "none"]);
    expect(warn).toHaveBeenCalledWith(
      "[narrator] tools rejected",
      expect.objectContaining({ error: expect.stringContaining("tool use") }),
    );
  });

  it("drops the tool turns when the provider rejects tools mid-loop", async () => {
    const transport = recording((request, n) => {
      if (n === 1) return toolReply([echoCall("c1")]);
      if (request.tools.kind === "offered") throw new ToolsRejectedError("tools not supported");
      return OK;
    });
    await callForValidReply(transport, CALL, parseOk, options(echoLoop()));
    expect(transport.calls.at(-1)?.continuation).toEqual(CALL.continuation);
  });

  it("answers calls past the per-round cap with 'not run' and cuts long results", async () => {
    const many = Array.from({ length: MAX_TOOL_CALLS_PER_ROUND + 1 }, (_, i) => echoCall(`c${i}`));
    const transport = scripted([toolReply(many), OK]);
    const long = echoLoop(4, () => "x".repeat(MAX_TOOL_RESULT_CHARS + 50));
    await callForValidReply(transport, CALL, parseOk, options(long));
    const results = transport.calls[1]?.continuation.filter((m) => m.role === "toolResult") ?? [];
    expect(results).toHaveLength(MAX_TOOL_CALLS_PER_ROUND + 1);
    expect(results[0]?.content).toHaveLength(MAX_TOOL_RESULT_CHARS + "… (cut)".length);
    expect(results.at(-1)?.content).toBe(
      `not run: at most ${MAX_TOOL_CALLS_PER_ROUND} tool calls a round`,
    );
  });

  it("offers no tools and ignores tool calls without a tool loop", async () => {
    const transport = scripted([{ ...OK, toolCalls: [echoCall("c1")] }]);
    const reply = await callForValidReply(transport, CALL, parseOk, options(NO_TOOL_LOOP));
    expect(reply.value).toBe(true);
    expect(transport.calls[0]?.tools).toEqual({ kind: "none" });
    expect(reply.toolCalls).toEqual([]);
  });
});

const PLAN = JSON.stringify({
  rationale: "Nothing yet.",
  intents: [],
  card: null,
  callBack: FIXTURE_CALL_BACK,
});
const NOTES = JSON.stringify({
  summary: "Read the thread first.",
  threads: [],
  cast: [],
  retired: [],
  endedArcs: [],
  plan: KEEP_PLAN,
});

describe("the notes turn's tools (§notes-turn-tools)", () => {
  const ctx = (transport: ModelTransport, extra: object = {}) => ({
    gameId: "g1",
    content: content(),
    callId: "call1",
    transport,
    ...extra,
  });

  it("offers the notes tools on the notes turn only, runs them, and records the calls", async () => {
    const transport = scripted([
      okResult(PLAN),
      toolReply([{ id: "t1", name: "pastArcs", arguments: "{}" }]),
      okResult(NOTES),
    ]);
    const run = await runNarratorWithTrace(quietTooLongRequest(content()), ctx(transport));
    const notes = await run.notesTurn?.();
    expect(notes).toMatchObject({ ok: true, toolCalls: [{ round: 1, name: "pastArcs" }] });
    expect(notes?.ok === true && notes.notes.summary).toBe("Read the thread first.");
    // The plan call is one-shot: no tools.
    expect(transport.calls[0]?.tools).toEqual({ kind: "none" });
    const notesRequest = transport.calls[1];
    expect(notesRequest?.tools).toMatchObject({ kind: "offered", choice: "auto" });
    const offered = notesRequest?.tools.kind === "offered" ? notesRequest.tools.tools : [];
    expect(offered.map((t) => t.name)).toContain("castMember");
    expect(notesRequest?.continuation.at(-1)?.content).toContain(NOTES_TOOLS_LINE);
    // The tool's answer came from the stored notes.
    const result = transport.calls[2]?.continuation.at(-1);
    expect(result).toMatchObject({ role: "toolResult", toolCallId: "t1" });
    expect(result?.content).toMatch(/^No past arcs: 0 have ended this game in all\.$/);
  });

  it("offers no tools and says nothing of them with maxToolRounds 0", async () => {
    const transport = scripted([okResult(PLAN), okResult(NOTES)]);
    const run = await runNarratorWithTrace(
      quietTooLongRequest(content()),
      ctx(transport, { maxToolRounds: 0 }),
    );
    const notes = await run.notesTurn?.();
    expect(notes).toMatchObject({ ok: true, toolCalls: [] });
    expect(transport.calls[1]?.tools).toEqual({ kind: "none" });
    expect(transport.calls[1]?.continuation.at(-1)?.content).not.toContain(NOTES_TOOLS_LINE);
  });
});
