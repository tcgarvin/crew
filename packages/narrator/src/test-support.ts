/**
 * Shared helpers for this package's tests (imported only by `*.test.ts`).
 */
import { loadBundle } from "@crew/content";
import type { ContentBundle } from "@crew/sim";
import type { NarratorPlan, NarratorRequest, NarratorResponse, WrittenNotes } from "./contract";
import { type RunNarratorCtx, runNarratorWithTrace } from "./run";
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
 * D97: a test fixture's whole answer, plan and notes together, as the model gave it before the
 * notes moved to their own turn. `fakeTransport` splits it between the two turns.
 */
export type PlanWithNotes = NarratorPlan & { readonly notes: WrittenNotes };

export function emptyPlan(overrides: Partial<PlanWithNotes> = {}): PlanWithNotes {
  return {
    rationale: "test",
    intents: [],
    card: null,
    notes: { summary: "so far", threads: [], cast: [] },
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
 * D97: a story fixture answer with `notes` goes to the plan turn without them and to the notes
 * turn as just the notes; any other answer (and every staging answer) is returned as given.
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
  const notesTurn = request.continuation.length > 0;
  return { ...result, content: JSON.stringify(notesTurn ? notes : plan) };
}

/**
 * D97: both turns, as the server runs them: the plan, then the notes turn, whose notes replace
 * the response's. A failed notes turn leaves the notes stored with the plan.
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
