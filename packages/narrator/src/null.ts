/**
 * The deterministic null narrator (PLAN §3 `NullNarrator`, review N3): no commands and, for a
 * policy decision, a template card, so the game stays playable with the LLM unavailable.
 */
import type { ContentBundle, DecisionId } from "@crew/sim";
import type { FallbackReason, NarratorRequest, NarratorResponse } from "./contract";
import { PROMPT_VERSION } from "./prompts/system";
import { templateCard } from "./templates";

export const NULL_NARRATOR_MODEL = "null-narrator";

export interface NullNarratorOptions {
  readonly callId?: string;
  readonly fallback?: FallbackReason;
  /** Enables port names in template text; without it IDs are shown. */
  readonly content?: ContentBundle;
}

export function nullNarratorResponse(
  req: NarratorRequest,
  options: NullNarratorOptions = {},
): NarratorResponse {
  const base = {
    commands: [],
    callId: options.callId ?? globalThis.crypto.randomUUID(),
    model: NULL_NARRATOR_MODEL,
    promptVersion: PROMPT_VERSION,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
  };
  if (req.hook.kind !== "policyDecision") return base;
  const decision = req.snapshot.state.decisions.records[req.hook.context.decisionId as DecisionId];
  if (decision === undefined) return base;
  return { ...base, card: templateCard(decision, options.content) };
}
