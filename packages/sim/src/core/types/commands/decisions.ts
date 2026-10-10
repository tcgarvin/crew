/**
 * Decision and hook commands (review §D.6, D5).
 */
import type { TextRef } from "../common";
import type { ActorId, DecisionId, HookId, JobId } from "../ids";
import type { CommandDraft } from "./index";

/**
 * One side of a card. `aftermath` (§aftermath-caption, additive) is copied onto the
 * `DecisionOption`.
 */
export interface DecisionCardSide {
  readonly label: TextRef;
  readonly commands: readonly CommandDraft[];
  readonly aftermath?: TextRef;
}

/**
 * A decision card as authored by the narrator or a policy. W0 decision: narrator cards are
 * single-level (no nested `next` card) to keep the LLM schema non-recursive; the kernel picks the
 * perspective actor (captain, else first officer, D8) when `perspectiveActorId` is absent.
 */
export interface DecisionCardSpec {
  readonly prompt: TextRef;
  readonly left: DecisionCardSide;
  readonly right: DecisionCardSide;
  readonly jobId?: JobId;
  /**
   * Additive (2026-09-30): an explicit perspective override for `surfaceDecision`, for a
   * system/scenario caller framing a card from someone other than the current command actor.
   * Absent = the kernel's D8 fallback (captain, else first officer).
   */
  readonly perspectiveActorId?: ActorId;
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
