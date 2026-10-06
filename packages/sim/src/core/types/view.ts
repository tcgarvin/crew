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
import type { Capacities, FactType, Interests, KnownFact, Needs, Thought, Values } from "./actor";
import type { DeepReadonly, PhysicalLocation, Tick, TileCoord, TileEdge } from "./common";
import type {
  ActivityDef,
  CargoClass,
  DeckDef,
  DirtTier,
  ItemTag,
  MachineTag,
  RoleTag,
  SkillLevels,
  ToolKind,
} from "./content";
import type { Significance } from "./events";
import type {
  ActivityDefId,
  ActorId,
  CompartmentId,
  DeckDefId,
  DockDefId,
  DoorId,
  EntityId,
  ItemDefId,
  ItemId,
  JobId,
  LocalId,
  LocalKey,
  MachineDefId,
  MachineId,
  PortDefId,
  SessionId,
  TraitDefId,
} from "./ids";
import type { DoorPhysicalState } from "./ship";
import type { GroupSession } from "./state";
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

/**
 * D77: who stands the helm, as the sim decides it (`systems/watch/helm.ts` `helmRoleOf`): this
 * section's `stander`, the next section's `oncoming` stander near the bell, a `relief` while a
 * relief post is open, or `none`. The planner's helm rule reads only this.
 */
export type HelmRole = "stander" | "oncoming" | "relief" | "none";

/** D77: the actor's place in the watch, from the bill and the tick. */
export interface WatchView {
  /** Their section's key; absent for a dayworker. */
  readonly section?: LocalKey;
  /** Their section has the watch now (always false for a dayworker). */
  readonly onWatch: boolean;
  /** D81: their section stands the next watch of the day (always false for a dayworker). */
  readonly nextOnWatch: boolean;
  readonly dayworker: boolean;
  readonly helmRole: HelmRole;
  /** Captain or first officer in the section on watch, and not its helm-stander. */
  readonly officerOfTheWatch: boolean;
  /**
   * D77 addendum: this is their sleep watch (the one after their own), when routine tiredness
   * is slept off; outside it only pressing tiredness sends them to bed. Present when true.
   */
  readonly sleepWatch?: true;
  /**
   * D77 addendum: they stand gangway watch now: docked with no helm watch wanted, and the
   * section on watch's gangway stander (`gangwayStanderOf`). Present when true.
   */
  readonly gangway?: true;
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
  /** D77: on duty now: their section has the watch, or a dayworker in working hours. */
  readonly onDuty: boolean;
  /** D77: their place in the watch. */
  readonly watch: WatchView;
  /** D79: what is on their mind (`Actor.thoughts`); mood is their clamped sum. */
  readonly thoughts: readonly DeepReadonly<Thought>[];
  readonly lastPlannedTick: Tick;
  /** W4a addition: the actor's own retry backoff (`Actor.workBackoff`); refs → retry tick. */
  readonly backoff?: Readonly<Record<string, Tick>>;
  /** Passengers §3.2: a paying passenger; never offered tasks or a post. */
  readonly passenger?: true;
  /** Passengers §3.5: walking off the ship; the planner keeps out of the way. */
  readonly disembarking?: true;
  /** D61: standing out on the dock alongside rather than aboard. Present when true. */
  readonly onDock?: true;
  /** D74: the bed assigned to this actor (`WorldState.berths`); absent while unberthed. */
  readonly berth?: { readonly machineId: MachineId };
  /** Slice 4: what they like doing off watch (`Actor.interests`). */
  readonly interests: DeepReadonly<Interests>;
  /** Slice 4: where they stand on the value axes (`Actor.values`). */
  readonly values: Readonly<Values>;
  /**
   * Slice 4: what they feel about every other actor (D88: `affinityOf`, compatibility plus
   * their memories), by actor. Nobody reads the other direction.
   */
  readonly affinity: Readonly<Record<ActorId, number>>;
  /**
   * Slice 4: a pending `privateTalk` this actor is part of: `captain` true for the one who
   * called it (they hold it at their desk), false for the one called in. `compartmentId` is the
   * caller's cabin.
   */
  readonly summons?: {
    readonly withActorId: ActorId;
    readonly compartmentId: CompartmentId;
    readonly captain: boolean;
  };
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
  /** Slice 4: whose it is (`Item.ownerId`, a personal item); common knowledge, like the def. */
  readonly ownerId?: ActorId;
}

/**
 * Slice 4: a group session as everyone aboard knows it (the intercom): the row plus the
 * activity's `label`.
 */
export type SessionView = DeepReadonly<GroupSession> & { readonly label: string };

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
  /**
   * D74: every bed assigned to someone (`WorldState.berths`), this actor's included, ashore or
   * aboard. Who sleeps where is common knowledge aboard, like the roster. The planner never
   * sleeps in one of these but its own (`self.berth`).
   */
  assignedBeds(): readonly MachineId[];
  /** W4a addition: items the actor holds a location belief about (plus what it carries). */
  knownItems(): readonly KnownItemView[];
  /**
   * Slice 4: every open or running group session (`social.sessions`). Common knowledge, like
   * the roster: on a ship this size everyone knows cards are on.
   */
  sessions(): readonly SessionView[];
  /** Slice 4: the ship's travel stage (common knowledge: the ship is docked or under way). */
  travel(): { readonly stage: TravelStage };
  /**
   * Slice 4: every off-watch activity def (`ContentBundle.activities`): what games the ship
   * has is common knowledge, like the schematic. The recreation candidate scores them.
   */
  activities(): readonly DeepReadonly<ActivityDef>[];
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
  /** Slice 4: the sessions the view saw. */
  readonly sessions: readonly SessionView[];
}

// ---------------------------------------------------------------------------------------------
// Render projection
// ---------------------------------------------------------------------------------------------

export interface RenderActor {
  readonly id: ActorId;
  readonly name: string;
  readonly deckId: DeckDefId;
  /**
   * Continuous tile-unit position (tile centre = x + 0.5), in the deck's frame. On the dock
   * (D59, D61) it lies outside the deck's authored bounds, possibly negative.
   */
  readonly x: number;
  readonly y: number;
  /**
   * D61: standing on the dock alongside (`RenderFrame.dock`), not aboard, so the renderer can draw
   * the person with the dock layer as it slides in and out. Always false with no dock.
   */
  readonly onDock: boolean;
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
  /**
   * Dockside (D58): how far open the leaf is, 0 shut to 1 fully open, so a ramp can be drawn
   * extending. A jammed door reads 0: it is impassable, as if shut.
   */
  readonly openFraction: number;
  /** Integration 1 addition: see `RenderMachine.placementKey`. */
  readonly deckId: DeckDefId;
  readonly placementKey: LocalKey;
}

/** Polish A (D28): coarse display class of an item, for colour and inspector wording. */
export type RenderItemKind = "crate" | "tool" | "food" | "other";

/**
 * Where a rendered item is. Only what is on the map reaches the frame: the deck, the dock
 * alongside (D61), and anyone's hands there. Port stores are off the map and installed
 * components are drawn as their machine.
 */
export type RenderItemLocation =
  | {
      readonly kind: "deck";
      readonly deckId: DeckDefId;
      /** Continuous tile-unit position, as `OnDeckLocation`. */
      readonly x: number;
      readonly y: number;
      /** D61: lying on the dock alongside rather than aboard, as `RenderActor.onDock`. */
      readonly onDock: boolean;
    }
  /** Carried or equipped: drawn riding the actor's dot. */
  | { readonly kind: "carried"; readonly actorId: ActorId }
  /** Inside a container that is itself on deck or carried. */
  | { readonly kind: "container"; readonly containerId: ItemId };

/**
 * Polish A (D28): an item on the map, so cargo loading is visible. Since D61 that includes the
 * dock alongside; `location.onDock` (or the carrier's) tells it from cargo aboard.
 */
export interface RenderItem {
  readonly id: ItemId;
  readonly defId: ItemDefId;
  readonly name: string;
  readonly kind: RenderItemKind;
  /** Freight class from the def, when it has one (drives the crate colour). */
  readonly cargoClass?: CargoClass;
  /** The contract this freight belongs to, if any. */
  readonly jobId?: JobId;
  /**
   * D63: freight on offer, staged on the dock: its job is not taken yet, so it is nobody's.
   * D66: also a closed offer's crates still on the dock while a dock hand fetches them back.
   * Absent for anything else (accepted freight, stores, parts).
   */
  readonly offered?: true;
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
 * Travel as the renderer sees it. Dockside §2.2: port-bound scenery is a pure function of stage,
 * progress and the two ports, so the frame names them.
 */
export interface RenderTravel {
  readonly state: TravelStage;
  /** Route fraction in `transit`, stage progress in the timed stages, 0 when docked. */
  readonly progress: number;
  /** The port being left; the port the ship is at while docked. */
  readonly fromPortId: PortDefId;
  /** The port being made for; the port the ship is at while docked. */
  readonly toPortId: PortDefId;
  /** Propulsion lost, progress halted (SD §17.1). Always false while docked. */
  readonly drifting: boolean;
}

/**
 * D61: the dock alongside, from the start of `docking` to the end of `undocking`. The map itself
 * is content (`ContentBundle.docks[dockId]`, a `DockDef`): with the deck at `shipAt` in its berth
 * box (`berthPlacement`, D72), its tile (x, y) is deck tile (x − shipAt.x, y − shipAt.y), so the
 * renderer draws it at `−shipAt` in deck coordinates plus the scenery's berth offset. Actors and items standing on it are in the frame's ordinary lists
 * with `onDock` set.
 */
export interface RenderDock {
  readonly dockId: DockDefId;
  /** The deck it is grafted onto (there is one). */
  readonly deckId: DeckDefId;
}

/**
 * D66: a local on the dock alongside: not crew, never in `actors`. Always on the dock, so always
 * drawn with the dock layer (as `onDock` actors are). Drawn as a dot in its own style from
 * `lookSeed`; tappable for name, role and post.
 */
export interface RenderLocal {
  readonly id: LocalId;
  readonly name: string;
  /** Lower case: "queue clerk", "dock hand". */
  readonly role: string;
  readonly deckId: DeckDefId;
  /** Continuous tile-unit position in the deck's frame (on the dock, so outside the deck). */
  readonly x: number;
  readonly y: number;
  /** Radians, 0 = east. */
  readonly facing: number;
  /** A uint32 palette seed, stable for the person (a hash of the name). */
  readonly lookSeed: number;
  /** The post they belong to (`DockDef.posts[].key`), for "at the queue kiosk". */
  readonly postKey: LocalKey;
  /** Short activity label ("waiting for a delivery", "bringing out 3 crates"); absent = none. */
  readonly label?: string;
  /** A narrator-invented face's one-line look; absent otherwise. */
  readonly look?: string;
  /** Crates on a dock hand's trolley right now (0 for anyone else). */
  readonly carrying: number;
}

/**
 * D66: a staged prop on the dock: set dressing drawn like the item it names, never an item
 * (nobody can pick it up), so it has no id. Its tile, deck frame, as a tile centre.
 */
export interface RenderDockProp {
  readonly defId: ItemDefId;
  readonly name: string;
  readonly kind: RenderItemKind;
  readonly cargoClass?: CargoClass;
  readonly count: number;
  readonly deckId: DeckDefId;
  readonly x: number;
  readonly y: number;
}

/**
 * D82: the dirt grid for the renderer's grime tint, on its own channel at its own cadence
 * (`host.dirtFrameEverySeconds`), keyed by tick so playback applies it at `viewTick`. One byte per
 * authored deck tile, row-major (`y × width + x`), 255 = 1.0 of dirt. Structured-clone safe but
 * not JSON: it never enters state (`WorldState.dirt.cells` holds plain integers).
 */
export interface DirtFrame {
  readonly tick: Tick;
  readonly deckId: DeckDefId;
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;
  /** The rooms' tiers at `tick` (`WorldState.dirt.tiers`), for the inspector's subtitle. */
  readonly tiers: Readonly<Record<LocalKey, DirtTier>>;
}

/**
 * Slice 4: a group session drawn as one plate at its venue (members' own labels are skipped).
 * `x`/`y` are the venue tile centre (tile units, deck frame); `label` is the def's `label` once
 * running, its `waitingLabel` while open.
 */
export interface RenderSession {
  readonly id: SessionId;
  readonly activityId: ActivityDefId;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly memberIds: readonly ActorId[];
  readonly running: boolean;
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
  readonly travel: RenderTravel;
  /** Notable/narrative events since the previous frame, already rendered to text. */
  readonly tickerEvents: readonly TickerEntry[];
  readonly money: number;
  /**
   * Polish A (D28): items on the map (on the deck or the dock, carried, or in a container that
   * is). D61: dock items have `onDock` set.
   */
  readonly items: readonly RenderItem[];
  /** D61: the dock alongside; absent while no dock is (in flight, or at a port without one). */
  readonly dock?: RenderDock;
  /** D66: the locals on the dock alongside; empty with no dock. */
  readonly locals: readonly RenderLocal[];
  /** D66: the staging plan's props on the dock alongside; empty with no dock. */
  readonly dockProps: readonly RenderDockProp[];
  /**
   * Polish A (D27): one plain-language line of what the ship is doing right now, e.g.
   * "Docked at Green Meridian — loading cargo (2 of 3 crates aboard)".
   */
  readonly headline: string;
  /** Slice 4: open and running group sessions, one plate each. */
  readonly sessions: readonly RenderSession[];
}
