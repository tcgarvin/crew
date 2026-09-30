/**
 * Decision and hook commands (review §D.6, D5).
 */
import type { TextRef } from "../common";
import type { DecisionId, HookId, JobId } from "../ids";
import type { CommandDraft } from "./index";

/**
 * A decision card as authored by the narrator or a policy. W0 decision: narrator cards are
 * single-level (no nested `next` card) to keep the LLM schema non-recursive; the kernel picks the
 * perspective actor (captain, else first officer, D8).
 */
export interface DecisionCardSpec {
  readonly prompt: TextRef;
  readonly left: { readonly label: TextRef; readonly commands: readonly CommandDraft[] };
  readonly right: { readonly label: TextRef; readonly commands: readonly CommandDraft[] };
  readonly jobId?: JobId;
}

export interface DecisionCommandPayloads {
  /** The player (or headless DecisionPolicy) picks a side of the head-of-queue decision. */
  resolveDecision: { readonly decisionId: DecisionId; readonly side: "left" | "right" };
  /** Queue a new decision card. */
  surfaceDecision: { readonly card: DecisionCardSpec };
  /**
   * Host tells the kernel the narrator round-trip for a hook is finished (after enqueuing any
   * returned commands at the hook tick), so `advance()` may proceed.
   */
  acknowledgeHook: { readonly hookId: HookId };
}
