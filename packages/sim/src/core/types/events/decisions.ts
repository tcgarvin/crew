import type { NarratorHookKind } from "../decisions";
/** Decision and narrator-hook events. */
import type { ActorId, DecisionId, HookId, LocalId, PortDefId } from "../ids";
import type { SignificanceCatalog } from "./significance";

/**
 * D70: why a held card came up: the meeting, the give-up clock, the ship no longer docked where it
 * was held, or no way for anyone to meet (no gate to walk through, nobody fit to walk).
 */
export type CardDeliveryReason = "met" | "gaveUp" | "leaving" | "noWayToMeet";

export interface DecisionEventPayloads {
  /** SD §16: crew will not act without authority; a policy decision was queued. */
  policyDecisionNeeded: { readonly decisionId: DecisionId };
  decisionPending: { readonly decisionId: DecisionId };
  decisionResolved: { readonly decisionId: DecisionId; readonly side: "left" | "right" };
  /**
   * A queued decision failed revalidation on presentation; D70: or a held offer card whose job
   * closed before it could be delivered.
   */
  decisionDropped: { readonly decisionId: DecisionId; readonly reason: string };
  narratorHookRaised: { readonly hookId: HookId; readonly kind: NarratorHookKind };
  narratorHookResolved: { readonly hookId: HookId };
  /** D70: a card from one of the port's people is held, to be delivered in person. */
  cardHeld: {
    readonly decisionId: DecisionId;
    readonly speaker: string;
    readonly portId: PortDefId;
  };
  /** D70: a held card came up (onto the decision queue). */
  cardDelivered: { readonly decisionId: DecisionId; readonly reason: CardDeliveryReason };
  /** D70: the captain stepped onto the dock looking for work (the `captainAshore` tick). */
  lookingForWork: {
    readonly actorId: ActorId;
    readonly name: string;
    readonly portId: PortDefId;
  };
  /** D70: the captain is talking with someone on the dock; their card follows. */
  talkingWith: { readonly actorId: ActorId; readonly name: string; readonly withName: string };
  /** D70: the captain went out through the gate to see someone in the port. */
  wentToSee: { readonly actorId: ActorId; readonly name: string; readonly withName: string };
  /** D70: someone is walking over to the ship with word for the captain. */
  cameToSee: { readonly localId: LocalId; readonly name: string; readonly fromGate: boolean };
}

export const DECISION_EVENT_SIGNIFICANCE = {
  policyDecisionNeeded: "narrative",
  decisionPending: "notable",
  decisionResolved: "narrative",
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
