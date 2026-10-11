/** Decision and narrator-hook events. */
import type { NarratorHookKind } from "../decisions";
import type { ActorId, DecisionId, HookId, LocalId, PortDefId } from "../ids";
import type { SignificanceCatalog } from "./significance";

/**
 * §holding-a-card: why a held card came up: the meeting, the give-up clock, the ship no longer
 * docked where it was held, or no way for anyone to meet (no gate to walk through, nobody fit to
 * walk).
 */
export type CardDeliveryReason = "met" | "gaveUp" | "leaving" | "noWayToMeet";

export interface DecisionEventPayloads {
  /** SD §16: crew will not act without authority; a policy decision was queued. */
  policyDecisionNeeded: { readonly decisionId: DecisionId };
  decisionPending: { readonly decisionId: DecisionId };
  decisionResolved: { readonly decisionId: DecisionId; readonly side: "left" | "right" };
  /**
   * §tried-sides: the captain chose a tried side and its odds were rolled once on the `narrator`
   * stream: `worked`, the side ran; else its failure branch did.
   */
  attemptRolled: {
    readonly decisionId: DecisionId;
    readonly side: "left" | "right";
    readonly odds: number;
    readonly worked: boolean;
  };
  /**
   * §tried-sides: an outcome lever on a failed try's branch was no longer possible when the roll
   * failed (its person dead, the money gone), so it did not apply.
   */
  failLeverRefused: {
    readonly decisionId: DecisionId;
    readonly kind: string;
    readonly reason: string;
  };
  /**
   * A queued decision failed revalidation on presentation, or (§stale-held-cards) a held offer card
   * whose job closed before it could be delivered.
   */
  decisionDropped: { readonly decisionId: DecisionId; readonly reason: string };
  narratorHookRaised: { readonly hookId: HookId; readonly kind: NarratorHookKind };
  narratorHookResolved: { readonly hookId: HookId };
  /** §holding-a-card: a card from one of the port's people is held, to be delivered in person. */
  cardHeld: {
    readonly decisionId: DecisionId;
    readonly speaker: string;
    readonly portId: PortDefId;
  };
  /** §delivery: a held card came up (onto the decision queue). */
  cardDelivered: { readonly decisionId: DecisionId; readonly reason: CardDeliveryReason };
  /**
   * §looking-for-work: the captain stepped onto the dock looking for work (the `captainAshore`
   * tick).
   */
  lookingForWork: {
    readonly actorId: ActorId;
    readonly name: string;
    readonly portId: PortDefId;
  };
  /**
   * §meetings-and-visitors: the captain is talking with someone on the dock; their card follows.
   */
  talkingWith: { readonly actorId: ActorId; readonly name: string; readonly withName: string };
  /** §meetings-and-visitors: the captain went out through the gate to see someone in the port. */
  wentToSee: { readonly actorId: ActorId; readonly name: string; readonly withName: string };
  /** §meetings-and-visitors: someone is walking over to the ship with word for the captain. */
  cameToSee: { readonly localId: LocalId; readonly name: string; readonly fromGate: boolean };
}

export const DECISION_EVENT_SIGNIFICANCE = {
  policyDecisionNeeded: "narrative",
  decisionPending: "notable",
  decisionResolved: "narrative",
  // Not hooked: the follow-up card and the aftermath are the reaction (narrator arcs §8.2).
  attemptRolled: "notable",
  failLeverRefused: "notable",
  decisionDropped: "notable",
  narratorHookRaised: "trace",
  narratorHookResolved: "trace",
  cardHeld: "trace",
  cardDelivered: "trace",
  // Shown in the log, never narrative: they must not wake `notableEvent` or reset the quiet timer.
  lookingForWork: "notable",
  talkingWith: "notable",
  wentToSee: "notable",
  cameToSee: "notable",
} as const satisfies SignificanceCatalog<DecisionEventPayloads>;
