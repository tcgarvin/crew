/**
 * `WorldState`: the whole authoritative, serialized game (review §C.1).
 *
 * Rules (checked by invariants and tests, see docs/CONTRACTS.md):
 * - Plain JSON-compatible objects only. It must survive `JSON.parse(JSON.stringify(state))`
 *   deep-equal. No `undefined` values (omit optional keys), no NaN/±Infinity/-0, no Map/Set/class
 *   instances/typed arrays.
 * - Kind tables `Record<Id, T>`, one owned slice per system. A system writes only its own slice
 *   (and the fields documented as its own on shared entities); everything else is read-only to it.
 * - Instance IDs come from `nextId` and are never reused.
 * - Anything derivable lives in `DerivedCaches`, not here.
 * - Events are not stored; `advance()` returns them.
 *
 * W0 decision: entity and table types are mutable (systems mutate in place, review §C.1); value
 * objects (locations, coords, text refs) and immutable data (content, commands, events, frames)
 * are `readonly`. Non-system readers get `ReadonlyWorldState` (`DeepReadonly<WorldState>`).
 */
import type { Actor } from "./actor";
import type { CommandsState } from "./commands";
import type { RngStreamName, Sfc32State, Tick } from "./common";
import type { CrewDef, ItemDef } from "./content";
import type { DecisionsState, NarratorState } from "./decisions";
import type { DocksideState } from "./dockside";
import type {
  ActorId,
  ClaimId,
  CompartmentId,
  CrewDefId,
  DoorId,
  ItemDefId,
  ItemId,
  JobId,
  LocalKey,
  MachineId,
  NextIdCounters,
  PortDefId,
  ProblemId,
  ScenarioDefId,
  TaskId,
} from "./ids";
import type { Compartment, DeckState, Door, Item, Machine, PowerState } from "./ship";
import type { Job, MoneyState, TravelState } from "./travel";
import type { Claim, Problem, Task } from "./work";

/**
 * Bumped on any breaking change to this shape. Each bump ships a `Migration` from the previous
 * version (see save.ts). 2 (2026-09-30): jobs gained `issuerPerson`, `pitch` and `urgency` (D25).
 * 3 (2026-10-01): `markets` (D47), seeded lazily from content for a port a save never visited.
 * 4 (2026-10-03): `deck.dock` is set from the start of `docking` to the end of `undocking` at a
 * port with a dock map (D61), so a save docked at one gets it on load.
 * 5 (2026-10-03): `dockside` (locals and props on the dock alongside), `narrator.staging` and the
 * `stageDock` hook, which replaces `approachingPort` (D66).
 * 6 (2026-10-03): `captainAshore` replaces `jobBoard` (and `captainAshoreLastAsk` the board's
 * last ask), `decisions.held` holds cards waiting to be delivered in person, and D42's
 * `Job.surfaceWhenDocked` is gone (D70).
 * 7 (2026-10-04): ship life slice 1 (D72, D74): Freighter Mk1 is mirrored bow-east, dock maps
 * declare a berth box, `berths` assigns beds and items may have an `ownerId`. Older saves are
 * refused rather than migrated (their tile coordinates are in the old frames).
 */
export const SCHEMA_VERSION = 7;

/** D47: one item on a port's market: units in stock and the per-unit price in integer credits. */
export interface MarketLine {
  count: number;
  price: number;
}

/** D47: a port's live market, keyed by item def. Absent item = not sold here. */
export type MarketStock = Record<ItemDefId, MarketLine>;

/** Work slice (W4): problems are written by their owning systems, tasks/claims by work. */
export interface WorkState {
  problems: Record<ProblemId, Problem>;
  tasks: Record<TaskId, Task>;
  claims: Record<ClaimId, Claim>;
  /** SD §15.1 fairness: rotating start offset for actor planning order. */
  plannerRotation: number;
}

/** Per-game generated definitions (review §C.6), embedded so a save is self-sufficient. */
export interface DynamicDefs {
  items: Record<ItemDefId, ItemDef>;
  crew: Record<CrewDefId, CrewDef>;
}

export interface WorldState {
  schemaVersion: number;
  /** Scenario this game started from (informational; content is referenced by hash in the save). */
  scenarioId: ScenarioDefId;
  /** Master seed, kept for bug reports. */
  seed: number;
  /** Last completed tick. A fresh world is at 0. */
  tick: Tick;
  rng: Record<RngStreamName, Sfc32State>;
  nextId: NextIdCounters;

  // Kind tables -------------------------------------------------------------------------------
  /** Owner: kernel spawn + spatial/needs/work per `Actor` field docs. */
  actors: Record<ActorId, Actor>;
  /** Owner: spatial (W3). */
  compartments: Record<CompartmentId, Compartment>;
  /** Owner: spatial (W3). Sparse dynamic tile state; static geometry is in `DeckDef`. */
  deck: DeckState;
  /** Owner: spatial (W3). Includes ramps. */
  doors: Record<DoorId, Door>;
  /** Owner: equipment (W5). */
  machines: Record<MachineId, Machine>;
  /** Owner: power (W5). */
  power: PowerState;
  /** Owner: inventory transfers (unique items and stacks share the table). */
  items: Record<ItemId, Item>;
  /**
   * Owner: needs (D74). Each berthed actor's bed: the `MachinePlacementDef.key` of a `bed`-tagged
   * machine on the ship's deck. No two actors share one; an actor without a berth has no key.
   */
  berths: Record<ActorId, LocalKey>;
  /** Owner: work (W4), problems by their owning systems. */
  work: WorkState;
  /** Owner: travel (W6). */
  travel: TravelState;
  /** Owner: commerce (W6). */
  jobs: Record<JobId, Job>;
  /** Owner: commerce (W6). Integer credits. */
  money: MoneyState;
  /**
   * Owner: commerce (D47). Per-port market stock, seeded from `PortDef.market` at world creation
   * and changed by purchases and the narrator's `stockMarket`. A port with no entry reads as its
   * content seed (`systems/commerce/market.ts` `effectiveMarket`), so an older save needs no
   * backfill beyond the empty table.
   */
  markets: Record<PortDefId, MarketStock>;
  /**
   * Owner: travel (the dock's people and props come and go with it) and commerce (dock-hand
   * errands). D66. Empty whenever no dock is alongside.
   */
  dockside: DocksideState;
  /** Owner: decisions. */
  decisions: DecisionsState;
  /** Owner: kernel core (quiet timer, budget) and decisions (pending hook). */
  narrator: NarratorState;
  /** Owner: kernel core (W2). */
  commands: CommandsState;
  /** Owner: kernel core (spawn commands add, nothing removes). */
  defs: { dynamic: DynamicDefs };
}
