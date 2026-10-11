/**
 * Shared helpers for this package's tests (imported only by `*.test.ts`).
 */
import { loadBundle } from "@crew/content";
import type { ContentBundle } from "@crew/sim";
import type { NarratorPlan, NarratorRequest, NarratorResponse, WrittenNotes } from "./contract";
import { REPAIR_HEADING } from "./model-call";
import { type RunNarratorCtx, runNarratorWithTrace } from "./run";
import { KEEP_PLAN, type WrittenPlan } from "./story-plan";
import type { ModelResult, ModelTransport } from "./transport";

let bundle: ContentBundle | undefined;

export function content(): ContentBundle {
  if (bundle === undefined) {
    const result = loadBundle();
    if (!result.ok) throw new Error("content failed validation");
    bundle = result.bundle;
  }
  return bundle;
}

/**
 * §notes-turn: a test fixture's whole answer, plan and notes together, as the model gave it before
 * the notes moved to their own turn. `fakeTransport` splits it between the two turns.
 */
export type PlanWithNotes = NarratorPlan & { readonly notes: FixtureNotes };

/**
 * §the-plan: a fixture's notes may leave the plan out; `fakeTransport` answers with `KEEP_PLAN`
 * then (every tier kept), as the model always writes one.
 */
export type FixtureNotes = Omit<WrittenNotes, "plan"> & { readonly plan?: WrittenPlan };

export function emptyPlan(overrides: Partial<PlanWithNotes> = {}): PlanWithNotes {
  return {
    rationale: "test",
    intents: [],
    card: null,
    notes: { summary: "so far", threads: [], cast: [], retired: [], endedArcs: [] },
    ...overrides,
  };
}

export function okResult(content: string): ModelResult {
  return {
    model: "anthropic/claude-opus-4.6",
    content,
    finish: "stop",
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    },
    reasoningDetails: [],
  };
}

/**
 * §notes-turn: a story fixture answer with `notes` goes to the plan turn without them
 * (§requested-call-back: and with `FIXTURE_CALL_BACK` if it has no callBack) and to the notes turn
 * as just the notes; any other answer (and every staging answer) is returned as given.
 */
function forTurn(result: ModelResult, request: Parameters<ModelTransport>[0]): ModelResult {
  if (result.content === null || request.schemaName !== "narrator_plan") return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return result;
  }
  if (parsed === null || typeof parsed !== "object" || !("notes" in parsed)) return result;
  const { notes, ...plan } = parsed as Record<string, unknown>;
  // §repair-turn: a repair request continues the plan's own turn, not the notes turn.
  const last = request.continuation.at(-1);
  const notesTurn = last !== undefined && !last.content.startsWith(REPAIR_HEADING);
  return {
    ...result,
    content: JSON.stringify(notesTurn ? withPlan(notes) : withCallBack(plan)),
  };
}

/**
 * §requested-call-back: the model always writes `callBack` (the schema requires it); a fixture plan
 * built without one answers with the plain request, nextPort, so it still parses.
 */
export const FIXTURE_CALL_BACK = { when: "nextPort", why: "" } as const;

function withPlan(notes: unknown): unknown {
  if (notes === null || typeof notes !== "object" || "plan" in notes) return notes;
  return { ...notes, plan: KEEP_PLAN };
}

function withCallBack(plan: Record<string, unknown>): Record<string, unknown> {
  const beats = { ...plan, intents: withBeats(plan.intents) };
  return "callBack" in plan ? beats : { ...beats, callBack: FIXTURE_CALL_BACK };
}

/** §beat-attribution: a fixture intent without `beat` serves none, as the model writes "". */
export function withBeats(intents: unknown): unknown {
  if (!Array.isArray(intents)) return intents;
  return intents.map((i: unknown) =>
    i !== null && typeof i === "object" && !("beat" in i) ? { ...i, beat: "" } : i,
  );
}

/**
 * §notes-turn: both turns, as the server runs them: the plan, then the notes turn, whose notes
 * replace the response's. A failed notes turn leaves the notes stored with the plan.
 */
export async function runBothTurns(
  req: NarratorRequest,
  ctx: RunNarratorCtx,
): Promise<NarratorResponse> {
  const run = await runNarratorWithTrace(req, ctx);
  if (run.notesTurn === undefined) return run.response;
  const notes = await run.notesTurn();
  return notes.ok ? { ...run.response, notesUpdate: notes.notes } : run.response;
}

/** A transport that answers with `result` and records what it was asked. */
export function fakeTransport(result: ModelResult | Error): ModelTransport & {
  readonly calls: Parameters<ModelTransport>[0][];
} {
  const calls: Parameters<ModelTransport>[0][] = [];
  const transport = async (request: Parameters<ModelTransport>[0]) => {
    calls.push(request);
    if (result instanceof Error) throw result;
    return forTurn(result, request);
  };
  return Object.assign(transport, { calls });
}
