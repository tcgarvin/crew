/**
 * Read projections: the planner's `AgentView` (SD §4.3) and the renderer's `RenderFrame`.
 *
 * `AgentView` is the only thing a planner sees. It exposes the actor's own body and inventory,
 * what the actor knows (facts, known problems and tasks), the static ship schematic every crew
 * member knows (SD §13.5) and a roster summary. It never exposes truth tables: no hidden faults,
 * remote door states, other people's true condition, or claims the actor has not learned of.
 *
 * The render frame is truth (D7: the player's map shows truth) but only what the canvas needs.
 */
import type { Capacities, FactType, KnownFact, Needs } from "./actor";
import type { DeepReadonly, PhysicalLocation, Tick, TileCoord, TileEdge } from "./common";
import type {
  CargoClass,
  DeckDef,
  ItemTag,
  MachineTag,
  RoleTag,
  SkillLevels,
  ToolKind,
} from "./content";
import type { Significance } from "./events";
import type {
  ActorId,
  CompartmentId,
  DeckDefId,
  DoorId,
  EntityId,
  ItemDefId,
  ItemId,
  JobId,
  LocalKey,
  MachineDefId,
  MachineId,
  TraitDefId,
} from "./ids";
import type { DoorPhysicalState } from "./ship";
import type { TravelStage } from "./travel";
import type { Activity, Problem, Task } from "./work";

// ---------------------------------------------------------------------------------------------
// AgentView
// ---------------------------------------------------------------------------------------------

export interface InventoryEntry {
  readonly itemId: ItemId;
  readonly defId: ItemDefId;
  readonly count: number;
}

/** The actor's own state: they always know their body, needs and what they carry. */
export interface SelfView {
  readonly id: ActorId;
  readonly name: string;
  readonly roleTags: readonly RoleTag[];
  readonly needs: Readonly<Needs>;
  readonly capacities: Readonly<Capacities>;
  readonly skills: SkillLevels;
  readonly traits: readonly TraitDefId[];
  readonly mood: number;
  readonly location: PhysicalLocation;
  /** Tile containing the actor, when on deck. */
  readonly tile?: TileCoord;
  readonly compartmentId?: CompartmentId;
  readonly activity: DeepReadonly<Activity>;
  readonly inventory: readonly InventoryEntry[];
  /** From the shift schedule at the current tick. */
  readonly onDuty: boolean;
  readonly lastPlannedTick: Tick;
  /** W4a addition: the actor's own retry backoff (`Actor.workBackoff`); refs → retry tick. */
  readonly backoff?: Readonly<Record<string, Tick>>;
  /** Passengers §3.2: a paying passenger; never offered tasks or a post. */
  readonly passenger?: true;
  /** Passengers §3.5: walking off the ship; the planner keeps out of the way. */
  readonly disembarking?: true;
}

/**
 * W4a addition: an item the actor has an `itemLocation` belief about, joined with its static
 * definition (what a ration pack is is common knowledge; where this one is, is belief).
 */
export interface KnownItemView {
  readonly itemId: ItemId;
  readonly defId: ItemDefId;
  readonly name: string;
  readonly tags: readonly ItemTag[];
  readonly toolKinds: readonly ToolKind[];
  /** Believed location (from the fact, not truth). */
  readonly location: PhysicalLocation;
  /** Believed tile, when the believed location is on deck. */
  readonly tile?: TileCoord;
  /** The actor looked and it was not there (see `FactValues.itemLocation.absent`). */
  readonly absent: boolean;
  readonly observedTick: Tick;
}

/** A task as its planner may see it. Claim bookkeeping is hidden (SD §14.5). */
export type TaskView = DeepReadonly<Omit<Task, "claimState">> & {
  /** From a `taskClaim` fact, if the actor has learned someone else claimed it. */
  readonly knownClaimantId?: ActorId;
};

export type ProblemView = DeepReadonly<Problem>;

/** A machine as the schematic shows it: where it is and what it is for, not how it is doing. */
export interface MachinePlacementView {
  readonly machineId: MachineId;
  readonly defId: MachineDefId;
  readonly tags: readonly MachineTag[];
  readonly footprint: readonly TileCoord[];
  /** Absolute tiles with their purposes. */
  readonly interactionTiles: readonly {
    readonly tile: TileCoord;
    readonly purposes: readonly ("operate" | "repair" | "use")[];
  }[];
}

/** The authored ship layout (static; every crew member knows it). */
export interface SchematicView {
  readonly deck: DeepReadonly<DeckDef>;
  isFloor(tile: TileCoord): boolean;
  compartmentAt(tile: TileCoord): CompartmentId | undefined;
  /** Static walls only; dynamic door/obstruction state comes from facts. */
  isWall(edge: TileEdge): boolean;
  doors(): readonly {
    readonly doorId: DoorId;
    readonly edge: TileEdge;
    readonly kind: "interior" | "ramp";
  }[];
  machines(): readonly MachinePlacementView[];
  /** Machines carrying a tag (beds, galley, pilot station). */
  amenities(tag: MachineTag): readonly MachinePlacementView[];
}

/** Basic roster knowledge (SD §13.5): who is aboard and their trained skills. */
export interface RosterEntry {
  readonly actorId: ActorId;
  readonly name: string;
  readonly roleTags: readonly RoleTag[];
  readonly skills: SkillLevels;
  /** Passengers §3.2: aboard as a passenger, not crew. Absent for crew. */
  readonly passenger?: true;
}

/**
 * Read-only accessor facade over one actor's knowledge plus the static schematic (review §C.3:
 * a facade, not a deep copy). Implemented in `view/` (W4a). Valid only during the planner call
 * that received it.
 */
export interface AgentView {
  readonly tick: Tick;
  readonly self: SelfView;
  readonly schematic: SchematicView;
  fact<T extends FactType>(
    subjectId: EntityId,
    factType: T,
  ): Extract<KnownFact, { factType: T }> | undefined;
  facts(): readonly DeepReadonly<KnownFact>[];
  knownProblems(): readonly ProblemView[];
  knownTasks(): readonly TaskView[];
  roster(): readonly RosterEntry[];
  /** W4a addition: items the actor holds a location belief about (plus what it carries). */
  knownItems(): readonly KnownItemView[];
  /**
   * W4a addition: schematic travel estimate in ticks from `from` (default: the actor's tile) to
   * `to`, or null if the layout has no route. Wraps spatial's `estimateTravelTicks`, which the
   * planner may not import. Ignores congestion and dynamic door state.
   */
  estimateTravelTicks(to: TileCoord, from?: TileCoord): number | null;
}

/**
 * Plain-data copy of an AgentView for the inspector (structured-clone safe).
 * W0 decision: the facade is not cloneable, so the worker protocol ships this snapshot instead.
 */
export interface AgentViewSnapshot {
  readonly tick: Tick;
  readonly self: SelfView;
  readonly facts: readonly DeepReadonly<KnownFact>[];
  readonly problems: readonly ProblemView[];
  readonly tasks: readonly TaskView[];
  readonly roster: readonly RosterEntry[];
}

// ---------------------------------------------------------------------------------------------
// Render projection
// ---------------------------------------------------------------------------------------------

export interface RenderActor {
  readonly id: ActorId;
  readonly name: string;
  readonly deckId: DeckDefId;
  /** Continuous tile-unit position (tile centre = x + 0.5). */
  readonly x: number;
  readonly y: number;
  /** Radians, 0 = east. */
  readonly facing?: number;
  /** Short present-tense verb phrase for the label: "repairing pump", "sleeping", "walking". */
  readonly actionLabel: string;
  /** Passengers §3.2: a paying passenger rather than crew, so the client can draw them apart. */
  readonly passenger: boolean;
}

export type RenderMachineState = "ok" | "degraded" | "failed" | "off";

export interface RenderMachine {
  readonly id: MachineId;
  readonly state: RenderMachineState;
  /** 0 ambient … 1 failure point. */
  readonly temperatureNorm?: number;
  /**
   * Integration 1 addition: lets a host that already has the static `DeckDef` (from
   * `@crew/content`) match this dynamic state back to the authored placement without guessing
   * instance-ID allocation order.
   */
  readonly deckId: DeckDefId;
  readonly placementKey: LocalKey;
}

export interface RenderDoor {
  readonly id: DoorId;
  readonly physicalState: DoorPhysicalState;
  /** Integration 1 addition: see `RenderMachine.placementKey`. */
  readonly deckId: DeckDefId;
  readonly placementKey: LocalKey;
}

/** Polish A (D28): coarse display class of an item, for colour and inspector wording. */
export type RenderItemKind = "crate" | "tool" | "food" | "other";

/**
 * Where a rendered item is. Only ship-side custody reaches the frame: port stores are ashore and
 * installed components are drawn as their machine.
 */
export type RenderItemLocation =
  | {
      readonly kind: "deck";
      readonly deckId: DeckDefId;
      /** Continuous tile-unit position, as `OnDeckLocation`. */
      readonly x: number;
      readonly y: number;
    }
  /** Carried or equipped: drawn riding the actor's dot. */
  | { readonly kind: "carried"; readonly actorId: ActorId }
  /** Inside a container that is itself on deck or carried. */
  | { readonly kind: "container"; readonly containerId: ItemId };

/** Polish A (D28): an item that is aboard, so cargo loading is visible on the map. */
export interface RenderItem {
  readonly id: ItemId;
  readonly defId: ItemDefId;
  readonly name: string;
  readonly kind: RenderItemKind;
  /** Freight class from the def, when it has one (drives the crate colour). */
  readonly cargoClass?: CargoClass;
  /** The contract this freight belongs to, if any. */
  readonly jobId?: JobId;
  readonly location: RenderItemLocation;
  /** Stack size; 1 for unique items. */
  readonly count: number;
}

export interface TickerEntry {
  readonly tick: Tick;
  readonly text: string;
  readonly significance: Significance;
}

/**
 * One frame for the canvas and HUD. Plain data, structured-clone safe (no class instances, no
 * functions). A Float32Array positions variant may be added later for large crews.
 * W0 decision: frames also carry `money` (HUD) and actor `name` (labels) beyond the minimum.
 */
export interface RenderFrame {
  readonly tick: Tick;
  readonly actors: readonly RenderActor[];
  readonly machines: readonly RenderMachine[];
  readonly doors: readonly RenderDoor[];
  readonly travel: { readonly state: TravelStage; readonly progress: number };
  /** Notable/narrative events since the previous frame, already rendered to text. */
  readonly tickerEvents: readonly TickerEntry[];
  readonly money: number;
  /** Polish A (D28): items aboard (on deck, carried, or in a container that is). */
  readonly items: readonly RenderItem[];
  /**
   * Polish A (D27): one plain-language line of what the ship is doing right now, e.g.
   * "Docked at Green Meridian — loading cargo (2 of 3 crates aboard)".
   */
  readonly headline: string;
}
