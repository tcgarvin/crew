import type { ActorId, PortDefId } from "../ids";
/**
 * Expedition events (expeditions A1, §8): the expedition started, the party armed, contact, every
 * shot (trace, for the tracers), someone breaking, the party pulling back, and the end with its
 * tally. The alert reuses the field's `alertRaised`/`alertCleared` with `cause: "fight"`.
 */
import type { ExpeditionOutcome } from "../state";
import type { SignificanceCatalog } from "./significance";

export interface ExpeditionEventPayloads {
  /**
   * The ship set down at `siteId`; `party` goes in, its leader first (empty when nobody can go).
   */
  expeditionStarted: { readonly siteId: PortDefId; readonly party: readonly ActorId[] };
  /** The party is armed at the locker: `armed` of `party` carry a weapon. */
  partyMustered: { readonly party: readonly ActorId[]; readonly armed: readonly ActorId[] };
  /** The cast noticed the party, or the party opened fire: the fight is on. */
  expeditionContact: { readonly siteId: PortDefId };
  /** `byActorId` fired at `atActorId`. */
  shotFired: { readonly byActorId: ActorId; readonly atActorId: ActorId; readonly hit: boolean };
  /** `actorId` of `side` broke: ran for it, or gave up. */
  combatantBroke: {
    readonly actorId: ActorId;
    readonly side: "us" | "them";
    readonly how: "fled" | "surrendered";
  };
  /** The party is pulling back to the ramp. */
  partyWithdrew: Record<string, never>;
  /**
   * The fight at `siteId` is over: how, how long from contact, and the tally; `targetName` names
   * the target for the log (the cast may be gone from `actors` by the time it is read).
   */
  expeditionResolved: {
    readonly siteId: PortDefId;
    readonly outcome: ExpeditionOutcome;
    readonly targetName?: string;
    readonly seconds: number;
    readonly shots: number;
    readonly woundsUs: number;
    /** The living party members wounded since the start (people, where `woundsUs` counts wounds). */
    readonly hurtUs: number;
    readonly woundsThem: number;
    readonly deadUs: number;
    readonly deadThem: number;
  };
}

export const EXPEDITION_EVENT_SIGNIFICANCE = {
  expeditionStarted: "notable",
  partyMustered: "trace",
  expeditionContact: "narrative",
  shotFired: "trace",
  combatantBroke: "notable",
  partyWithdrew: "notable",
  expeditionResolved: "narrative",
} as const satisfies SignificanceCatalog<ExpeditionEventPayloads>;
