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
   * D26 (additive, 2026-09-30): one line shown for a moment after this side is chosen, before
   * the card closes, saying plainly what happens next. No numbers.
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
   * D70: the tick a card held for delivery in person came onto the queue (the meeting); the
   * card is shown from then, not from `createdTick`. Absent for a card queued when created.
   */
  deliveredTick?: Tick;
  resolvedTick?: Tick;
  chosen?: "left" | "right";
  /** The job this decision is about, if any (job offers are decisions, review §D.6.7). */
  jobId?: JobId;
  /**
   * D37: the `policyDecision` hook raised for a kernel-raised decision, set when it reached the
   * head of the queue (`core/decisions.ts`). Absent on narrator cards and job offers, which
   * carry their own prose.
   */
  narratorHookId?: HookId;
}

/**
 * D70 (replaces D42's `Job.surfaceWhenDocked`): a card from one of the port's people, waiting to
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
 * D70: a held card's meeting, under way. `via` is who walks so that the speaker and the captain
 * meet. `captain`: the command actor goes to them (across the dock to a local, or out through the
 * gate to someone in the port beyond it), as they do when ashore looking for work. `speaker`:
 * they come to the foot of the personnel ramp (a local on the dock walks over; anyone else walks
 * in from the gate).
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
   * D70: cards waiting to be delivered in person, oldest first. Never in `queue` at the same
   * time; delivered (moved onto the queue) when the captain and the speaker meet, or after
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
   * D66 (replaces `approachingPort`): the staging call, raised `narrator.approachHookLeadSeconds`
   * before transit ends at a port with a dock map, and guaranteed: travel holds at the end of the
   * route until it is acknowledged. Its only story-free answer is one `stageDock` command
   * (`STAGING_COMMAND_KINDS`); the kernel rejects every other narrator command while it is
   * pending. `floorSet` is who the sim will place on its own (`core/floor-set.ts`), as it stands
   * at the raise tick.
   */
  stageDock: { portId: PortDefId; dockId: DockDefId; floorSet: FloorSetEntry[] };
  /**
   * D70 (replaces `jobBoard`): the captain (or the command actor, D8) walked down the ramp
   * looking for work and stepped onto the dock this tick. Raised once per docking
   * (`NarratorState.captainAshoreLastAsk`).
   */
  captainAshore: { portId: PortDefId; actorId: ActorId };
  quietTooLong: { quietSinceTick: Tick };
  notableEvent: { eventIds: EventId[] };
  policyDecision: { decisionId: DecisionId; machineId?: MachineId };
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
   * `config.narrator.budgetRefillDays`, `core/pipeline.ts`).
   */
  budget: { spawnsRemaining: number; faultsRemaining: number; hazardsRemaining: number };
  /** D78: the tick the budget was last refilled (world creation counts as one). */
  budgetRefilledTick: Tick;
  /** Resolved hooks, most recent last, trimmed to a small tail (for the digest). */
  recentHookIds: HookId[];
  /**
   * The most recent `narrative`-significance event committed (phase 8, `core/pipeline.ts`),
   * preferring within one tick an event whose type is in `config.narrator.hookOnEvents`. Travel
   * raises the `notableEvent` hook from it the following tick (events are stamped after the
   * systems run, so a hook cannot be raised in the same tick), by way of `pendingNotable`.
   */
  lastNarrativeEvent?: { tick: Tick; type: string; eventId?: EventId };
  /**
   * D69: the latest hookable event (type in `config.narrator.hookOnEvents`) still owed a
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
   * (D46 amendment): pacing is the narrator's judgement, not a timer's. D70 renamed it from
   * `jobBoardLastAsk` (same lifetime) and added `actorId`: whoever went ashore meets the people
   * the answer names, for the rest of the docking, even if the command perspective (D8) moves.
   */
  captainAshoreLastAsk?: { portId: PortDefId; tick: Tick; actorId: ActorId };
}
