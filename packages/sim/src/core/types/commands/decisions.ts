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
  /**
   * §follow-up-cards: the card shown straight after this side is chosen. `surfaceDecision` mints it
   * as its own pending record (not queued) and links it as the option's `nextDecisionId`. A
   * follow-up card has no follow-ups of its own.
   */
  readonly next?: DecisionCardSpec;
  /**
   * §tried-sides: the side is a try. When it is chosen the kernel rolls `attempt.odds` once on the
   * `narrator` stream: if it works the side runs as above (`commands`, `aftermath`, `next`); if not,
   * `attempt`'s failure branch runs instead.
   */
  readonly attempt?: DecisionCardAttempt;
}

/**
 * §tried-sides: a tried side's chance and its failure branch, copied onto the option's `attempt`.
 * `failCommands` run as `player`, like `commands`; `failLevers` are outcome levers
 * (`FAIL_LEVER_KINDS`) run as `narrator` and only on failure, so `AUTHORITY.player` is unchanged.
 */
export interface DecisionCardAttempt {
  /** A whole percent, 0 to 100, unclamped otherwise (narrator arcs §8.4). */
  readonly odds: number;
  readonly failCommands: readonly CommandDraft[];
  readonly failLevers: readonly CommandDraft[];
  readonly failAftermath?: TextRef;
  /** §follow-up-cards: the card shown straight after the try fails. */
  readonly failNext?: DecisionCardSpec;
}

/**
 * A decision card as authored by the narrator or a policy. The kernel picks the perspective actor
 * (captain, else first officer, D8) when `perspectiveActorId` is absent. W0 kept narrator cards
 * single-level; §follow-up-cards allows one level of `next` card per side, never deeper, so the
 * plan schema stays non-recursive.
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
