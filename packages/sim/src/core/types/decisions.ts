/**
 * Decisions and narrator hooks (PLAN §3, review §D.6, D5). Both are first-class sim state so a
 * pause survives save/load. Ownership: the decisions system (W6 builds it with the hook points;
 * W2 wires `resolveDecision` through the command path).
 */
import type { CommandDraft } from "./commands";
import type { TextRef, Tick, TileCoord } from "./common";
import type { FloorSetEntry } from "./dockside";
import type {
  ActorId,
  DecisionId,
  DockDefId,
  EventId,
  HookId,
  JobId,
  LocalId,
  MachineId,
  PortDefId,
} from "./ids";

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

export interface DecisionOption {
  label: TextRef;
  /**
   * Applied atomically when this side is chosen, revalidated at that moment.
   * W0 decision: option commands run with source `player` (the player chose them), so they must
   * be kinds in `AUTHORITY.player`; this is checked both when the decision is created and when
   * it resolves.
   */
  commands: CommandDraft[];
  /** Binary tree: surface this decision next after applying the commands. */
  nextDecisionId?: DecisionId;
  /**
   * §aftermath-caption (additive, 2026-09-30): one line shown for a moment after this side is
   * chosen, before the card closes, saying plainly what happens next. No numbers.
   */
  aftermath?: TextRef;
}

export type DecisionStatus = "pending" | "resolved" | "dropped";

export interface Decision {
  id: DecisionId;
  origin: "policy" | "narrator";
  /** Captain, or first officer when the captain is asleep/incapacitated (D8), fixed at creation. */
  perspectiveActorId: ActorId;
  prompt: TextRef;
  left: DecisionOption;
  right: DecisionOption;
  status: DecisionStatus;
  createdTick: Tick;
  /**
   * §delivered-tick: the tick a card held for delivery in person came onto the queue (the meeting);
   * the card is shown from then, not from `createdTick`. Absent for a card queued when created.
   */
  deliveredTick?: Tick;
  resolvedTick?: Tick;
  chosen?: "left" | "right";
  /** The job this decision is about, if any (job offers are decisions, review §D.6.7). */
  jobId?: JobId;
  /**
   * §policy-decision-hook: the `policyDecision` hook raised for a kernel-raised decision, set when
   * it reached the head of the queue (`core/decisions.ts`). Absent on narrator cards and job
   * offers, which carry their own prose.
   */
  narratorHookId?: HookId;
}

/**
 * §holding-a-card: a card from one of the port's people, waiting to
 * be delivered in person. Its decision record exists (status `pending`) but it is not in the
 * queue, so nothing halts until the meeting puts it there (`core/delivery.ts` `deliverHeldCard`).
 */
export interface HeldCard {
  decisionId: DecisionId;
  /** The person the card names (an offer's issuer, a card's speaker), as written. */
  speaker: string;
  /** The port it is delivered at, the one the ship was docked at when it was held. */
  portId: PortDefId;
  heldTick: Tick;
  /**
   * How the meeting is happening, once it has begun (absent until then): decided from where the
   * walker is when the delivery starts, not when the card is held, so a captain who came back
   * aboard in between is not sent out again for nothing.
   */
  delivery?: CardDelivery;
}

/**
 * §meetings-and-visitors: a held card's meeting, under way. `via` is who walks so that the speaker
 * and the captain meet. `captain`: the command actor goes to them (across the dock to a local, or
 * out through the gate to someone in the port beyond it), as they do when ashore looking for work.
 * `speaker`: they come to the foot of the personnel ramp (a local on the dock walks over; anyone
 * else walks in from the gate).
 */
export type CardDelivery =
  | {
      via: "captain";
      sinceTick: Tick;
    }
  | {
      via: "speaker";
      sinceTick: Tick;
      /** The local walking to the ramp: one already on the dock, or a visitor from the gate. */
      localId: LocalId;
      /** Where they are walking to: the foot of the personnel ramp (deck frame). */
      tile: TileCoord;
    };

export interface DecisionsState {
  records: Record<DecisionId, Decision>;
  /**
   * Pending decisions, FIFO. The head is the one presented; the host stays paused while this is
   * non-empty. Queued entries are revalidated on presentation and dropped with an event if stale.
   */
  queue: DecisionId[];
  /**
   * §holding-a-card: cards waiting to be delivered in person, oldest first. Never in `queue` at the
   * same time; delivered (moved onto the queue) when the captain and the speaker meet, or after
   * `travel.cardDeliveryGiveUpSeconds`.
   */
  held: HeldCard[];
}

// ---------------------------------------------------------------------------------------------
// Narrator hooks (D5)
// ---------------------------------------------------------------------------------------------

/** Per-kind context the kernel attaches so the narrator digest knows why it was called. */
export interface HookContexts {
  /**
   * §staging-hook-and-the-hold: the staging call, raised
   * `narrator.approachHookLeadSeconds` before transit ends at a port with a dock map, and
   * guaranteed: travel holds at the end of the route until it is acknowledged. Its only story-free
   * answer is one `stageDock` command (`STAGING_COMMAND_KINDS`); the kernel rejects every other
   * narrator command while it is pending. `floorSet` is who the sim will place on its own
   * (`core/floor-set.ts`), as it stands at the raise tick.
   */
  stageDock: { portId: PortDefId; dockId: DockDefId; floorSet: FloorSetEntry[] };
  /**
   * §looking-for-work: the captain (or the command actor, D8) walked down the ramp
   * looking for work and stepped onto the dock this tick. Raised once per docking
   * (`NarratorState.captainAshoreLastAsk`).
   */
  captainAshore: { portId: PortDefId; actorId: ActorId };
  quietTooLong: { quietSinceTick: Tick };
  notableEvent: { eventIds: EventId[] };
  policyDecision: { decisionId: DecisionId; machineId?: MachineId };
  /**
   * §requested-call-back: the call the narrator asked for (`NarratorState.callBack`), now due: the
   * tick the ship cast off (`departure`) or halfway through a transit (`midLeg`). `why` is its own
   * private line, read back to it; `requestedTick` is when it asked. A `nextPort` request raises
   * nothing: it is served by the first story hook docked elsewhere.
   */
  requestedCall: { when: "departure" | "midLeg"; why: string; requestedTick: Tick };
}

export type NarratorHookKind = keyof HookContexts;

interface NarratorHookBase<K extends NarratorHookKind> {
  id: HookId;
  kind: K;
  context: HookContexts[K];
  tick: Tick;
}

/**
 * A point where the sim pauses for the narrator. The kernel raises it and stops advancing; the
 * host calls the server, enqueues returned commands at `tick`, then acknowledges with
 * `hookResolved`. Only one hook is pending at a time.
 */
export type NarratorHook = { [K in NarratorHookKind]: NarratorHookBase<K> }[NarratorHookKind];

/**
 * §requested-call-back: when the narrator wants its next call. `nextPort` is the default and raises
 * nothing.
 */
export const CALL_BACK_WHEN = ["nextPort", "departure", "midLeg"] as const;
export type CallBackWhen = (typeof CALL_BACK_WHEN)[number];

/** §requested-call-back: the longest private `why` a call-back request may carry. */
export const CALL_BACK_WHY_MAX = 200;

/** §strike-lever: the longest `how` line a `strike` may carry (it is the ticker line aboard). */
export const STRIKE_HOW_MAX = 120;

/** §money-levers: the longest `memo` and `counterparty` a `transact` may carry. */
export const TRANSACT_TEXT_MAX = 80;

/** §memory-levers: the longest `over` a `fallOut` may carry (who or what it is over). */
export const FALL_OUT_OVER_MAX = 80;

/**
 * §requested-call-back: the narrator's standing request for its next call (the `requestCall`
 * command). One at a time; every story call's plan replaces it. It is deleted when the hook that
 * served it is acknowledged; a request that never comes due stands until the next one replaces it.
 */
export interface CallBackRequest {
  when: CallBackWhen;
  /** Private, read back on the call it asked for; at most `CALL_BACK_WHY_MAX` characters. */
  why: string;
  requestedTick: Tick;
  /**
   * `nextPort` only: the port the ship was docked at when asked (absent if asked in flight). It
   * is served by the first story hook raised while docked anywhere else.
   */
  portId?: PortDefId;
  /**
   * `midLeg` only: asked in transit before the halfway point, so this transit (its
   * `stageStartedTick`) is the one meant. Absent otherwise: the next transit is.
   */
  legStartedTick?: Tick;
  /** The story hook that served it; `acknowledgeHook` deletes the request with that hook. */
  servedByHookId?: HookId;
}

/**
 * Narrator-facing bookkeeping kept in sim state (review §D.3: budgets are state).
 * Ownership: kernel core (W2) for the quiet timer; decisions system for `pendingHook`.
 */
export interface NarratorState {
  /** The hook the sim is paused on; `advance()` returns immediately while set. */
  pendingHook?: NarratorHook;
  /**
   * Tick of the last narrator contact: the later of the last `narrative`-significance event and
   * the last hook raised (any kind). Drives `quietTooLong`.
   */
  lastNarrativeTick: Tick;
  /**
   * Remaining narrator-caused spawns/faults/hazards before the budget refills (every
   * `config.narrator.budgetRefillDays`, `core/pipeline.ts`). §narrator-lever-budgets: advice the
   * digest shows, never a refusal; each lever still spends one, so a count below zero is how far
   * past it the narrator has gone.
   */
  budget: { spawnsRemaining: number; faultsRemaining: number; hazardsRemaining: number };
  /**
   * §narrator-lever-budgets: the tick the budget was last refilled (world creation counts as one).
   */
  budgetRefilledTick: Tick;
  /** Resolved hooks, most recent last, trimmed to a small tail (for the digest). */
  recentHookIds: HookId[];
  /**
   * The most recent `narrative`-significance event committed (phase 8, `core/pipeline.ts`),
   * preferring within one tick an event whose type is in `config.narrator.hookOnEvents`
   * (or a hookable aftermath event, which may be of `notable` significance; §notable-event-hook).
   * Travel raises the `notableEvent` hook from it the following tick (events are stamped after the
   * systems run, so a hook cannot be raised in the same tick), by way of `pendingNotable`.
   */
  lastNarrativeEvent?: { tick: Tick; type: string; eventId?: EventId };
  /**
   * §notable-event-hook: the latest hookable event (type in `config.narrator.hookOnEvents`, or
   * `aftermathHookOnEvents` that passes its filter) still owed a
   * `notableEvent` hook. Set when it is committed (phase 8); travel raises the hook from it the
   * first tick no other hook is pending, so a staging call raised the tick after the event no
   * longer swallows it. A story hook raised after the event clears it, since that call reads
   * the event anyway. Absent when nothing is owed.
   */
  pendingNotable?: { tick: Tick; type: string; eventId?: EventId };
  /**
   * The `captainAshore` ask of the current docking (port, tick, and who walked ashore), so the
   * narrator is asked once per docking; cleared the moment travel leaves `docked`, so the next
   * docking at any port asks again. D46 briefly re-asked on a timer; the owner withdrew that
   * (D46 amendment): pacing is the narrator's judgement, not a timer's. `actorId` is whoever went
   * ashore: they meet the people the answer names, for the rest of the docking, even if the
   * command perspective (D8) moves.
   */
  captainAshoreLastAsk?: { portId: PortDefId; tick: Tick; actorId: ActorId };
  /** §requested-call-back: the narrator's standing call-back request; absent when none stands. */
  callBack?: CallBackRequest;
}
