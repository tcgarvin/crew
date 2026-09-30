import type { CommandDraft } from "./commands";
/**
 * Decisions and narrator hooks (PLAN §3, review §D.6, D5). Both are first-class sim state so a
 * pause survives save/load. Ownership: the decisions system (W6 builds it with the hook points;
 * W2 wires `resolveDecision` through the command path).
 */
import type { TextRef, Tick } from "./common";
import type { ActorId, DecisionId, EventId, HookId, JobId, MachineId, PortDefId } from "./ids";

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
  resolvedTick?: Tick;
  chosen?: "left" | "right";
  /** The job this decision is about, if any (job offers are decisions, review §D.6.7). */
  jobId?: JobId;
}

export interface DecisionsState {
  records: Record<DecisionId, Decision>;
  /**
   * Pending decisions, FIFO. The head is the one presented; the host stays paused while this is
   * non-empty. Queued entries are revalidated on presentation and dropped with an event if stale.
   */
  queue: DecisionId[];
}

// ---------------------------------------------------------------------------------------------
// Narrator hooks (D5)
// ---------------------------------------------------------------------------------------------

/** Per-kind context the kernel attaches so the narrator digest knows why it was called. */
export interface HookContexts {
  approachingPort: { portId: PortDefId; etaTicks: number };
  jobBoard: { portId: PortDefId };
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
  /** Tick of the last `narrative`-significance event; drives `quietTooLong`. */
  lastNarrativeTick: Tick;
  /** Remaining narrator-caused spawns/faults before the budget refills. */
  budget: { spawnsRemaining: number; faultsRemaining: number };
  /** Resolved hooks, most recent last, trimmed to a small tail (for the digest). */
  recentHookIds: HookId[];
}
