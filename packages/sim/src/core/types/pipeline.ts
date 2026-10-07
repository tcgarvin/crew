/**
 * Step pipeline contracts (SD §5.2–5.3, review §C.3).
 *
 * The pipeline is a static, declarative array in `core/pipeline.ts` (W2) covering the eight
 * phases in order. No dynamic registration: ordering is part of the sim version. A system is a
 * function over `StepCtx`; the planner is special and only ever sees an `AgentView`.
 */
import type { DeepReadonly, RngStreamName, Tick, TileCoord } from "./common";
import type {
  ConfigDef,
  ContentBundle,
  CrewDef,
  DeckDef,
  ItemDef,
  MachineDef,
  PortDef,
  TraitDef,
} from "./content";
import type { EventDraft, SimEvent } from "./events";
import type {
  ActorId,
  CompartmentId,
  CrewDefId,
  DecisionId,
  DeckDefId,
  ItemDefId,
  ItemId,
  MachineDefId,
  MachineId,
  PortDefId,
  TraitDefId,
} from "./ids";
import type { DeckGeometry } from "./nav";
import type { WorldState } from "./state";
import type { AgentView } from "./view";
import type { Intent } from "./work";

/** The eight phases of one tick, in execution order (SD §5.2). */
export const PHASES = [
  /** 1. Apply due commands and impacts; commit lifecycle and inventory transfers. */
  "inputs",
  /** 2. Refresh invalidated topology and networks; allocate power. */
  "topology",
  /** 3. Advance movement and actions; commit completed actions and door transitions. */
  "actions",
  /** 4. Advance environment and equipment: heat, wear, hazards, faults. */
  "equipment",
  /** 5. Advance bodies and needs. */
  "needs",
  /** 6. Deliver information and observe; update knowledge; raise discovered problems. */
  "perception",
  /** 7. Derive tasks, expire claims, run due planners, assign next actions for next tick. */
  "planning",
  /** 8. Finalise events (ids, seq, significance), hooks, diagnostics, invariants. */
  "finalize",
] as const;

export type Phase = (typeof PHASES)[number];

// ---------------------------------------------------------------------------------------------
// Randomness API
// ---------------------------------------------------------------------------------------------

/**
 * Seeded draws over the named sfc32 streams in `state.rng` (review §C.5). The only randomness a
 * system may use; `Math.random` and `Date` are banned in the kernel (D4).
 */
export interface RngApi {
  /** Uniform in [0, 1): `u32 / 2**32`. Advances the stream. */
  float(stream: RngStreamName): number;
  /** Uniform integer in [min, max] inclusive. */
  int(stream: RngStreamName, min: number, max: number): number;
  chance(stream: RngStreamName, probability: number): boolean;
  /** Throws on an empty list. */
  pick<T>(stream: RngStreamName, items: readonly T[]): T;
  /** Throws if all weights are zero. */
  weighted<T>(
    stream: RngStreamName,
    items: readonly { readonly item: T; readonly weight: number }[],
  ): T;
  /**
   * Keyed draw `hash(seed, stream, key, counter)` that does not advance the stream, so adding a
   * machine or a narrator fault does not perturb every other entity's future (review §C.5).
   */
  keyedFloat(stream: RngStreamName, key: string, counter: number): number;
}

// ---------------------------------------------------------------------------------------------
// Derived caches (never serialized)
// ---------------------------------------------------------------------------------------------

/** Invalidation flags; a system that changes topology sets them, phase 2 consumes them. */
export interface DirtyFlags {
  /** Doors, obstructions or floor changed: rebuild navigation passability. */
  navigation: boolean;
  /** Machine modes, breakers or faults changed: reallocate power. */
  power: boolean;
  /** Item custody changed: rebuild holder indexes. */
  inventory: boolean;
}

/**
 * Rebuildable caches. `restore()` rebuilds all of them from state + content and sets every dirty
 * flag, so nothing here may be authoritative. Typed arrays are fine here (not in state). Each
 * cache is owned by one workstream; add fields to your own interface only.
 */
export interface DerivedCaches {
  dirty: DirtyFlags;
  /** Owner: spatial (W3). */
  nav: NavCache;
  /** Owner: kernel core (W2); rebuilt when `dirty.inventory`. */
  index: IndexCache;
  /** Owner: kernel core (W2). Bounded diagnostic rings (SD §15.7, §20.2). */
  diagnostics: DiagnosticsCache;
}

export interface NavCache {
  /** `DeckState.geometryRevision` this cache was built for. */
  geometryRevision: number;
  /**
   * Per deck: row-major passability of tile edges, bit per side (n=1, e=2, s=4, w=8 blocked).
   * W3 decision: static walls plus door edges (a door edge needs a door check to cross).
   */
  edgeMask: Record<DeckDefId, Uint8Array>;
  /** W3 addition: per-deck geometry (walkable grid, compartments, doors by edge, interaction positions). */
  decks: Record<DeckDefId, DeckGeometry>;
  /**
   * W3 addition: lazily cached A* results keyed by deck, planning policy, from and to. Cleared when
   * the geometry revision changes.
   */
  paths: Map<string, readonly TileCoord[] | null>;
  /**
   * W3 addition: exclusive interaction-position reservations, `${deckId}:${x},${y}` → holders.
   * Not state: rebuilt from actor positions and routes on restore (see systems/spatial/reservations.ts).
   */
  reservations: Record<string, ActorId[]>;
}

export interface IndexCache {
  /** Items whose location is `carriedBy`/`equippedBy` this actor. */
  itemsByHolder: Record<ActorId, ItemId[]>;
  /** Items whose location is `inContainer` this item. Rebuilt with `itemsByHolder`. */
  itemsByContainer: Record<ItemId, ItemId[]>;
  /**
   * On-deck actors by the compartment of the tile they stand on. Rebuilt every tick in phase 2 and
   * updated incrementally by movement (W3) in phase 3 whenever an actor changes compartment.
   */
  actorsByCompartment: Record<CompartmentId, ActorId[]>;
  /** Machines by the compartment of their placement origin tile. */
  machinesByCompartment: Record<CompartmentId, MachineId[]>;
}

export interface DiagnosticsCache {
  /** Recent `trace` events for the inspector. */
  traceEvents: SimEvent[];
  plannerTraces: { tick: Tick; actorId: ActorId; intent: Intent }[];
  /**
   * W2 addition: `notable`+ events returned by the most recent `advance()` call, bounded by
   * `config.events.tickerMaxEntries`; feeds `RenderFrame.tickerEvents`.
   */
  lastEvents: SimEvent[];
  /** W2 addition: head of `state.decisions.queue` already announced with `decisionPending`. */
  announcedDecisionId: DecisionId | null;
}

// ---------------------------------------------------------------------------------------------
// Definition lookup
// ---------------------------------------------------------------------------------------------

/**
 * Resolves a definition ID against the static bundle, then `state.defs.dynamic`. Throws on an
 * unknown ID: content validation (L2) guarantees references resolve, so a miss is a bug.
 */
export interface DefLookup {
  deck(id: DeckDefId): DeckDef;
  machine(id: MachineDefId): MachineDef;
  item(id: ItemDefId): ItemDef;
  crew(id: CrewDefId): CrewDef;
  trait(id: TraitDefId): TraitDef;
  port(id: PortDefId): PortDef;
}

// ---------------------------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------------------------

/** Everything a system may touch during one run. */
export interface StepCtx {
  /** Mutable truth. Write only your own slice (see `WorldState` owner notes). */
  readonly state: WorldState;
  readonly caches: DerivedCaches;
  readonly content: ContentBundle;
  readonly defs: DefLookup;
  readonly config: ConfigDef;
  readonly rng: RngApi;
  /** Buffer an event. Events are outputs: no system reads them back within the tick. */
  emit(event: EventDraft): void;
  /** The tick being computed (`state.tick + 1` until phase 8 commits it). */
  readonly tick: Tick;
  /** Ticks since this system last ran (its cadence); integrate rates over this (SD §5.3). */
  readonly elapsedTicks: number;
  /** Alias of `caches.dirty`. */
  readonly dirty: DirtyFlags;
  /**
   * W2 addition: for a `staggerBy: "actor"` system, the actors due this tick (in `state.actors`
   * key order). Absent for other systems, meaning "all actors". With stagger, `elapsedTicks` is
   * the per-actor interval (`every`).
   */
  readonly dueActorIds?: readonly ActorId[];
}

export interface System {
  readonly name: string;
  readonly phase: Phase;
  /** Run every N ticks (default 1). */
  readonly every?: number;
  /** Spread an `every > 1` system's per-actor work across ticks by actor index. */
  readonly staggerBy?: "actor";
  run(ctx: StepCtx): void;
}

/**
 * What a planner may read about tuning.
 * W4a addition: `time`, so the planner can put travel (ticks, from the view) and work
 * (`estimatedWorkSeconds`) on one scale for SD §15.3 step 5.
 *
 * Slice 4: `recreation`, `social` and `mood`, for the recreation candidate's join threshold,
 * affinity bands and mood bands. Slice 5: `field`, `damage` and `intercom`, for the alert's
 * candidates and the reporting reflex.
 */
export type PlannerConfig = Pick<
  ConfigDef,
  | "work"
  | "urgency"
  | "needs"
  | "time"
  | "galley"
  | "recreation"
  | "social"
  | "mood"
  | "field"
  | "damage"
  | "intercom"
>;

/**
 * The planner (phase 7) is a pure function of one actor's view. It never sees `StepCtx`, state,
 * RNG or content tables (SD §4.3). The work system turns its `Intent` into claims and actions.
 */
export type Planner = (view: AgentView, config: PlannerConfig) => Intent;

/**
 * The planning stage in the pipeline. Its cadence is `config.work.reconsiderEveryTicks`,
 * staggered by actor; actors whose current action is invalid are planned immediately.
 */
export interface PlannerStage {
  readonly kind: "planner";
  readonly phase: "planning";
  readonly planner: Planner;
}

export type PipelineEntry = ({ readonly kind: "system" } & System) | PlannerStage;

/** The static pipeline: entries in phase order, stable within a phase. */
export type Pipeline = readonly PipelineEntry[];

/** Read-only state for non-system readers. */
export type ReadonlyWorldState = DeepReadonly<WorldState>;
