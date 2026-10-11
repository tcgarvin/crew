/**
 * One model call, shared by the story call (`run.ts`), its notes turn and the staging call
 * (`staging/run.ts`): send the prompt through the injected transport, turn every way it can fail
 * into a `FallbackError` with a `FallbackReason`, and parse the reply as JSON. Each caller
 * validates the JSON against its own schema. §repair-turn: `callForValidReply` hands a reply that
 * fails that validation back to the model with what was wrong, in the same conversation.
 * §notes-turn-tools: given a tool loop, it first runs the tool calls the model asks for, a bounded
 * number of rounds inside the same budget, and the reply after them is the one validated.
 */
import type { FallbackReason, NarratorUsage } from "./contract";
import {
  type ContinuationMessage,
  type ModelRequest,
  type ModelResult,
  type ModelTool,
  type ModelTransport,
  NO_TOOLS,
  type ToolCall,
  type ToolOffer,
  ToolsRejectedError,
  TransportError,
} from "./transport";

export class FallbackError extends Error {
  constructor(
    readonly reason: FallbackReason,
    message: string,
    /**
     * §repair-turn: for `schemaInvalid`, what was wrong with the reply, written to the model
     * (empty for any other reason).
     */
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = "FallbackError";
  }
}

/** A `ModelRequest` with a timeout in place of the abort signal. */
type ModelCall = Omit<ModelRequest, "signal"> & { readonly timeoutMs: number };

export async function callModel(transport: ModelTransport, call: ModelCall): Promise<ModelResult> {
  const { timeoutMs, ...request } = call;
  try {
    return await transport({ ...request, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // §notes-turn-tools: the tool loop asks again without tools; never a fallback of its own.
    if (err instanceof ToolsRejectedError) throw err;
    if (err instanceof TransportError) throw new FallbackError(err.kind, err.message);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new FallbackError("timeout", "narrator call timed out");
    }
    // A transport that throws anything else is still a provider failure, not a game failure.
    throw new FallbackError("apiError", err instanceof Error ? err.message : String(err));
  }
}

/** The reply text, or the fallback reason a refusal, truncation or empty reply means. */
export function contentOf(result: ModelResult): string {
  if (result.finish === "refusal") {
    throw new FallbackError("refusal", result.refusal ?? "model refused");
  }
  if (result.finish === "length") throw new FallbackError("truncated", "output hit max tokens");
  if (result.content === null || result.content.trim() === "") {
    throw new FallbackError("schemaInvalid", "empty model output", ["Your reply was empty."]);
  }
  return result.content;
}

/** Some providers wrap JSON in a code fence even in JSON mode; accept that one variation. */
function stripFence(content: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return fenced?.[1] ?? content;
}

export function parseJsonReply(content: string): unknown {
  try {
    return JSON.parse(stripFence(content));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new FallbackError("schemaInvalid", "model output is not JSON", [
      `Your reply was not valid JSON (${err.message}).`,
    ]);
  }
}

/** The zod issue fields the repair turn reads. */
interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
  /** `invalid_union`: each branch's own issues. */
  readonly errors?: readonly (readonly SchemaIssue[])[];
  /** `invalid_value`: the values allowed. */
  readonly values?: readonly unknown[];
}

/** A top-level literal mismatch: the issue a union branch gives for another branch's tag. */
function isLiteralMismatch(issue: SchemaIssue): boolean {
  return issue.code === "invalid_value" && issue.path.length === 1 && issue.values?.length === 1;
}

/** The branch's issue saying the value is not this branch at all: its tag is another literal. */
function tagMismatch(branch: readonly SchemaIssue[], key: PropertyKey): SchemaIssue | undefined {
  return branch.find((issue) => isLiteralMismatch(issue) && issue.path[0] === key);
}

/** The union's tag (`kind`): the top-level key the most branches reject as the wrong literal. */
function unionTag(branches: readonly (readonly SchemaIssue[])[]): PropertyKey | undefined {
  const counts = new Map<PropertyKey, number>();
  for (const issue of branches.flat()) {
    const key = issue.path[0];
    if (isLiteralMismatch(issue) && key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: PropertyKey | undefined;
  for (const [key, count] of counts) {
    if (best === undefined || count > (counts.get(best) ?? 0)) best = key;
  }
  return best;
}

/**
 * §repair-turn: an intent that matches no branch of a union is reported by zod as one bare
 * "Invalid input". Spelled out instead: the issues of the one branch whose tag (`kind`) the value
 * carries, or, when no branch has that tag, the tags allowed.
 */
function unionIssues(issue: SchemaIssue): readonly SchemaIssue[] {
  const branches = issue.errors ?? [];
  const key = unionTag(branches);
  if (key === undefined) return [issue];
  const tagged = branches.filter((branch) => tagMismatch(branch, key) === undefined);
  const [only] = tagged;
  if (tagged.length === 1 && only !== undefined) {
    return only.flatMap((inner) => flatIssues({ ...inner, path: [...issue.path, ...inner.path] }));
  }
  if (tagged.length === 0) {
    const allowed = branches.flatMap((branch) => tagMismatch(branch, key)?.values ?? []);
    return [
      {
        path: [...issue.path, key],
        message: `not one of the allowed values: ${allowed.map((v) => JSON.stringify(v)).join("|")}`,
      },
    ];
  }
  return [issue];
}

function flatIssues(issue: SchemaIssue): readonly SchemaIssue[] {
  return issue.code === "invalid_union" ? unionIssues(issue) : [issue];
}

/** §repair-turn: at most this many issues are listed back to the model; the rest are counted. */
const MAX_LISTED_ISSUES = 20;
/** §repair-turn: a zod message quoting a long value is cut, so one issue cannot crowd the rest. */
const MAX_ISSUE_CHARS = 240;

function issuePath(issue: SchemaIssue): string {
  return issue.path.length === 0 ? "(the whole reply)" : issue.path.map(String).join(".");
}

/** §repair-turn: every zod issue as one compact line, path then message. */
export function issueLines(zodIssues: readonly SchemaIssue[]): string[] {
  const issues = zodIssues.flatMap(flatIssues);
  const listed = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => {
    const message =
      issue.message.length > MAX_ISSUE_CHARS
        ? `${issue.message.slice(0, MAX_ISSUE_CHARS)}…`
        : issue.message;
    return `at ${issuePath(issue)}: ${message}`;
  });
  const more = issues.length - listed.length;
  return more > 0 ? [...listed, `(and ${more} more)`] : listed;
}

/**
 * A zod failure as the fallback: the message (for logs) is the first issue's path and text; the
 * problems (§repair-turn, for the model) are every issue.
 */
export function schemaIssue(what: string, issues: readonly SchemaIssue[]): FallbackError {
  const issue = issues[0];
  return new FallbackError(
    "schemaInvalid",
    `${what} failed validation at ${issue === undefined ? "?" : issue.path.map(String).join(".")}: ${issue?.message ?? ""}`,
    ["Your reply failed the schema:", ...issueLines(issues)],
  );
}

// ---------------------------------------------------------------------------------------------
// §repair-turn
// ---------------------------------------------------------------------------------------------

/** §repair-turn: how many times a call hands an invalid reply back before it gives up. */
export const DEFAULT_MAX_REPAIRS = 2;
/**
 * §repair-turn: the least time a repair needs left in the call's budget. A repair is asked only
 * when the time remaining is at least this and at least as long as the attempt that just failed
 * took, since the corrected reply is the whole reply again (over a cached prefix, so rarely
 * slower). The floor covers a failed attempt that came back almost at once (an empty reply).
 */
export const MIN_REPAIR_MS = 4_000;

/** The first line of every repair request, so a fake transport can tell one from a notes turn. */
export const REPAIR_HEADING = "# Your reply could not be used";

export interface RepairRecord {
  /** 1 for the first repair asked within the call. */
  readonly attempt: number;
  /** What was wrong with the reply this repair answered, as told to the model. */
  readonly problems: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// §notes-turn-tools
// ---------------------------------------------------------------------------------------------

/** §notes-turn-tools: tool rounds a notes turn may spend before it is asked for its notes. */
export const DEFAULT_MAX_TOOL_ROUNDS = 4;
/**
 * §notes-turn-tools: tools are offered only while at least this much of the call's budget is left,
 * which is what the final answer (the whole notes JSON, with reasoning) needs.
 */
export const TOOL_RESERVE_MS = 20_000;
/** §notes-turn-tools: calls run per round; any more are answered "not run". */
export const MAX_TOOL_CALLS_PER_ROUND = 6;
/** §notes-turn-tools: a tool result is cut to this many characters. */
export const MAX_TOOL_RESULT_CHARS = 2_000;
/** §notes-turn-tools: how much of a result the call log keeps. */
const LOGGED_RESULT_CHARS = 300;

/** The first line of the turn that closes the tools, so a fake transport can tell it apart. */
export const TOOLS_CLOSED_HEADING = "# No more tools";

/**
 * §notes-turn-tools: the read-only tools a call may use. `run` never throws: an unknown tool,
 * malformed arguments or an unknown name is a result that says so.
 */
export type ToolLoop =
  | { readonly kind: "none" }
  | {
      readonly kind: "loop";
      readonly tools: readonly ModelTool[];
      readonly run: (name: string, args: string) => string;
      readonly maxRounds: number;
    };

export const NO_TOOL_LOOP: ToolLoop = { kind: "none" };

/** §notes-turn-tools: one tool call as the call log records it. */
export interface ToolCallRecord {
  /** 1 for the first round of tool calls within the call. */
  readonly round: number;
  readonly name: string;
  readonly arguments: string;
  /** The result's length before any cut, and its opening for the log. */
  readonly resultChars: number;
  readonly result: string;
}

/** §notes-turn-tools: the user turn that ends the tool rounds. */
export function toolsClosedRequest(why: "rounds" | "time"): string {
  const reason = why === "rounds" ? "That was the last round of tool calls." : "Time is short.";
  return `${TOOLS_CLOSED_HEADING}\n\n${reason} Answer now with your complete JSON object only: no more tool calls, no prose, no code fence.`;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (cut)`;
}

const isToolTurn = (m: ContinuationMessage) => m.role === "toolRequest" || m.role === "toolResult";

export interface RepairOptions {
  readonly maxRepairs: number;
  /** Extra fields for the `[narrator] repair` and `[narrator] tool` log lines (game and call ids). */
  readonly logContext: Readonly<Record<string, string>>;
  /** §notes-turn-tools: `NO_TOOL_LOOP` for every call but the notes turn. */
  readonly tools: ToolLoop;
  /** Milliseconds clock; injectable so tests can spend the budget without waiting. */
  readonly now?: () => number;
}

export interface ValidReply<T> {
  readonly value: T;
  /** The accepted reply's text. */
  readonly content: string;
  /** The model that gave the accepted reply. */
  readonly model: string;
  /** Every attempt's usage, summed: a repair or a tool round is billed like any call. */
  readonly usage: NarratorUsage;
  /**
   * The turns after the first user turn, ending with the accepted reply and its reasoning, so a
   * later turn (§notes-turn) continues the whole conversation, repairs and tool calls included.
   */
  readonly conversation: readonly ContinuationMessage[];
  readonly repairs: readonly RepairRecord[];
  /** §notes-turn-tools: every tool call the model made, in order. */
  readonly toolCalls: readonly ToolCallRecord[];
}

/**
 * Thrown by `callForValidReply` for any failure: the `FallbackError` of the last attempt, with the
 * reply it was about (if any), the repairs asked before it and the tool calls made.
 */
export class ReplyFailedError extends FallbackError {
  constructor(
    cause: FallbackError,
    readonly rawContent: string | undefined,
    readonly repairs: readonly RepairRecord[],
    readonly toolCalls: readonly ToolCallRecord[],
    suffix: string,
  ) {
    super(cause.reason, `${cause.message}${suffix}`, cause.problems);
    this.name = "ReplyFailedError";
  }
}

function addUsage(a: NarratorUsage, b: NarratorUsage): NarratorUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

const NO_USAGE: NarratorUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/** §repair-turn: the user turn that hands an invalid reply back. */
export function repairRequest(problems: readonly string[]): string {
  return [
    REPAIR_HEADING,
    "",
    ...problems,
    "",
    "Answer again with the complete corrected JSON object: the whole reply, not only the parts that changed, and nothing else (no prose, no code fence).",
  ].join("\n");
}

/**
 * The model's invalid reply as the assistant turn, with its reasoning. An empty reply has no turn:
 * a provider may refuse an assistant message with no text.
 */
function replyTurn(result: ModelResult): ContinuationMessage[] {
  if (result.content === null || result.content.trim() === "") return [];
  return [
    { role: "assistant", content: result.content, reasoningDetails: result.reasoningDetails },
  ];
}

/**
 * The state one `callForValidReply` keeps across its model calls: the conversation so far, the
 * usage, and the tool loop's progress (§notes-turn-tools).
 */
class Conversation {
  turns: readonly ContinuationMessage[];
  usage: NarratorUsage = NO_USAGE;
  readonly toolCalls: ToolCallRecord[] = [];
  rounds = 0;
  /** §notes-turn-tools: tools stay declared once offered, so the cached prefix stays the same. */
  toolsDeclared: boolean;
  toolsClosed = false;
  /** When the last model call started, for the repair's time check. */
  lastCallStartedAt: number;

  constructor(
    readonly tools: ToolLoop,
    start: readonly ContinuationMessage[],
    startedAt: number,
  ) {
    this.turns = start;
    this.toolsDeclared = tools.kind === "loop" && tools.tools.length > 0 && tools.maxRounds > 0;
    this.lastCallStartedAt = startedAt;
  }

  /** The tools this model call offers: callable on the first attempt while rounds and time last. */
  offer(firstAttempt: boolean, remainingMs: number, log: Readonly<Record<string, unknown>>) {
    const loop = this.tools;
    if (loop.kind === "none" || !this.toolsDeclared) return NO_TOOLS;
    const closedFor =
      this.rounds >= loop.maxRounds ? "rounds" : remainingMs < TOOL_RESERVE_MS ? "time" : undefined;
    if (firstAttempt && closedFor === undefined) {
      return { kind: "offered", tools: loop.tools, choice: "auto" } satisfies ToolOffer;
    }
    // Once the model has called a tool, closing the tools says so and asks for the answer.
    if (firstAttempt && closedFor !== undefined && !this.toolsClosed && this.rounds > 0) {
      this.toolsClosed = true;
      console.info("[narrator] tools closed", { ...log, why: closedFor, rounds: this.rounds });
      this.turns = [...this.turns, { role: "user", content: toolsClosedRequest(closedFor) }];
    }
    return { kind: "offered", tools: loop.tools, choice: "none" } satisfies ToolOffer;
  }

  /** §notes-turn-tools: the provider refused tools: the rest of the call goes without them. */
  dropTools(log: Readonly<Record<string, unknown>>, error: ToolsRejectedError) {
    console.warn("[narrator] tools rejected", { ...log, error: error.message });
    this.toolsDeclared = false;
    this.turns = this.turns.filter(
      (m) => !isToolTurn(m) && !(m.role === "user" && m.content.startsWith(TOOLS_CLOSED_HEADING)),
    );
  }

  /** §notes-turn-tools: runs one round of the model's calls and appends them and their results. */
  runTools(result: ModelResult, log: Readonly<Record<string, unknown>>) {
    const loop = this.tools;
    if (loop.kind === "none") return;
    this.rounds += 1;
    const results = result.toolCalls.map((call: ToolCall, i): ContinuationMessage => {
      const full =
        i < MAX_TOOL_CALLS_PER_ROUND
          ? loop.run(call.name, call.arguments)
          : `not run: at most ${MAX_TOOL_CALLS_PER_ROUND} tool calls a round`;
      const text = cut(full, MAX_TOOL_RESULT_CHARS);
      this.toolCalls.push({
        round: this.rounds,
        name: call.name,
        arguments: call.arguments,
        resultChars: full.length,
        result: cut(full, LOGGED_RESULT_CHARS),
      });
      console.info("[narrator] tool", {
        ...log,
        round: this.rounds,
        name: call.name,
        args: cut(call.arguments, 200),
        chars: full.length,
      });
      return { role: "toolResult", toolCallId: call.id, content: text };
    });
    this.turns = [
      ...this.turns,
      {
        role: "toolRequest",
        content: result.content ?? "",
        reasoningDetails: result.reasoningDetails,
        toolCalls: result.toolCalls,
      },
      ...results,
    ];
  }
}

/**
 * §notes-turn-tools: one attempt's model calls: each reply that asks for tools (while they are
 * offered) has them run and the model called again; the first reply that does not is returned. A
 * provider that refuses tools is asked again without them.
 */
async function askModel(
  transport: ModelTransport,
  call: ModelCall,
  convo: Conversation,
  firstAttempt: boolean,
  deadline: number,
  now: () => number,
  log: Readonly<Record<string, unknown>>,
): Promise<ModelResult> {
  for (;;) {
    const offer = convo.offer(firstAttempt, deadline - now(), log);
    convo.lastCallStartedAt = now();
    let result: ModelResult;
    try {
      result = await callModel(transport, {
        ...call,
        continuation: convo.turns,
        tools: offer,
        timeoutMs: Math.max(1, deadline - convo.lastCallStartedAt),
      });
    } catch (err) {
      if (!(err instanceof ToolsRejectedError)) throw err;
      convo.dropTools(log, err);
      continue;
    }
    convo.usage = addUsage(convo.usage, result.usage);
    const asked = offer.kind === "offered" && offer.choice === "auto";
    if (!asked || result.toolCalls.length === 0) return result;
    convo.runTools(result, log);
  }
}

/**
 * §repair-turn: one model call whose reply must pass `parse`. A reply that is empty, not JSON or
 * fails the schema (`schemaInvalid`, thrown by `parse` or `contentOf`) is handed back in the same
 * conversation (the model's reply, then a user turn listing what was wrong), up to
 * `maxRepairs` times, while the call's `timeoutMs` (one budget for every attempt) leaves room.
 * Any other failure ends the call at once. Throws `ReplyFailedError`. §notes-turn-tools: with a
 * tool loop, the first attempt may spend tool rounds before its reply; repairs offer none.
 */
export async function callForValidReply<T>(
  transport: ModelTransport,
  call: Omit<ModelCall, "tools">,
  parse: (content: string) => T,
  options: RepairOptions,
): Promise<ValidReply<T>> {
  const now = options.now ?? Date.now;
  const calledAt = now();
  const deadline = calledAt + call.timeoutMs;
  const repairs: RepairRecord[] = [];
  const convo = new Conversation(options.tools, call.continuation, calledAt);
  const log = { ...options.logContext, schema: call.schemaName };
  for (;;) {
    let result: ModelResult | undefined;
    try {
      result = await askModel(
        transport,
        { ...call, tools: NO_TOOLS },
        convo,
        repairs.length === 0,
        deadline,
        now,
        log,
      );
      const content = contentOf(result);
      const value = parse(content);
      return {
        value,
        content,
        model: result.model,
        usage: convo.usage,
        conversation: [...convo.turns, ...replyTurn(result)],
        repairs,
        toolCalls: convo.toolCalls,
      };
    } catch (err) {
      if (!(err instanceof FallbackError)) throw err;
      const rawContent = result?.content ?? undefined;
      const fail = (suffix: string) =>
        new ReplyFailedError(err, rawContent, repairs, convo.toolCalls, suffix);
      const repaired = repairs.length === 0 ? "" : ` (after ${repairs.length} repairs)`;
      if (err.reason !== "schemaInvalid" || result === undefined) throw fail(repaired);
      if (repairs.length >= options.maxRepairs) throw fail(repaired);
      const remainingMs = deadline - now();
      if (remainingMs < Math.max(MIN_REPAIR_MS, now() - convo.lastCallStartedAt)) {
        throw fail(`${repaired} (no time left to repair: ${remainingMs} ms)`);
      }
      const record: RepairRecord = { attempt: repairs.length + 1, problems: err.problems };
      repairs.push(record);
      console.warn("[narrator] repair", {
        ...log,
        attempt: record.attempt,
        remainingMs,
        issues: err.problems.join(" "),
      });
      convo.turns = [
        ...convo.turns,
        ...replyTurn(result),
        { role: "user", content: repairRequest(err.problems) },
      ];
    }
  }
}
