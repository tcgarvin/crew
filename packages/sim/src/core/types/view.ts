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
import type { DeckDef, MachineTag, RoleTag, SkillLevels } from "./content";
import type { Significance } from "./events";
import type {
  ActorId,
  CompartmentId,
  DeckDefId,
  DoorId,
  EntityId,
  ItemDefId,
  ItemId,
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
}

export type RenderMachineState = "ok" | "degraded" | "failed" | "off";

export interface RenderMachine {
  readonly id: MachineId;
  readonly state: RenderMachineState;
  /** 0 ambient … 1 failure point. */
  readonly temperatureNorm?: number;
}

export interface RenderDoor {
  readonly id: DoorId;
  readonly physicalState: DoorPhysicalState;
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
}
