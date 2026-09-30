/**
 * Actor state (SD §11.1) and actor knowledge (SD §13.1). Captain and first officer use the same
 * model; a role tag exempts nobody from needs, movement or work.
 *
 * Ownership: identity/roles set at spawn (kernel); `location`/`movement` by spatial (W3);
 * `needs` by needs (W4a); `activity` by work (W4); `knowledge` by perception (whoever builds
 * observation in W4/W5); `skills` by work (experience gain); `availability` by needs/bodies.
 */
import type { PhysicalLocation, Tick, TileCoord } from "./common";
import type { RoleTag, SkillLevels } from "./content";
import type {
  ActorId,
  CrewDefId,
  DoorId,
  EntityId,
  ItemId,
  LocalKey,
  MachineId,
  ProblemId,
  TaskId,
  TraitDefId,
} from "./ids";
import type { Activity, Intent } from "./work";

/**
 * Need deficits in [0, 1] (0 = satisfied, 1 = critical). W0 decision (see ConfigDef.needs).
 */
export interface Needs {
  hunger: number;
  fatigue: number;
  comfort: number;
  social: number;
}

export type NeedKey = keyof Needs;

/**
 * Body capacities in [0, 1]. Bodies/wounds are deferred (PLAN §7); V1 keeps these at 1 except
 * for fatigue effects, so speed and work formulas have their inputs from day one.
 */
export interface Capacities {
  movement: number;
  manipulation: number;
  consciousness: number;
}

/** SD §11.1 availability. Sleeping is an activity, not an availability state. */
export type Availability = "available" | "incapacitated" | "dead" | "offShip";

/**
 * Authoritative route state (SD §7.1), enough to resume exactly after save/load.
 * `path` is the sequence of tile centres; segment i runs from path[i] to path[i+1].
 */
export type MovementState =
  | {
      kind: "stationary";
      /**
       * W3 addition: why the last route ended without arriving. Set by spatial; the work system
       * (W4) treats it as "replan now" and it is cleared by the next `requestMove`.
       */
      routeFailure?: RouteFailure;
    }
  | {
      kind: "moving";
      path: TileCoord[];
      segmentIndex: number;
      /** Distance in tiles travelled along the current segment. */
      segmentDistanceTravelled: number;
      /** Tiles/second after all modifiers (SD §7.3), recomputed when a modifier changes. */
      effectiveSpeed: number;
      /** Knowledge revision the route was planned against; mismatch triggers a replan. */
      navigationKnowledgeRevision: number;
      /** Set while waiting on a blocked tile or door; cleared when moving again. */
      blockedSinceTick?: Tick;
      /** Door the actor is waiting on or currently crossing, if any. */
      doorId?: DoorId;
    };

/** W3 addition: a route that ended early, for the planner to react to. */
export interface RouteFailure {
  readonly tick: Tick;
  /**
   * `blocked`: an obstruction or a door that would not open. `positionTaken`: the destination
   * interaction position stayed occupied past the bounded wait. `unreachable`: a knowledge
   * change left no route.
   */
  readonly reason: "blocked" | "positionTaken" | "unreachable";
  /** Tile the actor could not enter. */
  readonly tile: TileCoord;
}

/**
 * Schedule (SD §11.4). `shiftKey` indexes `config.shifts.shifts`; on/off duty is derived from
 * the tick, not stored.
 */
export interface Schedule {
  shiftKey: LocalKey;
}

// ---------------------------------------------------------------------------------------------
// Knowledge (SD §13.1)
// ---------------------------------------------------------------------------------------------

/** Small typed fact catalog. Add a type by adding a key to `FactValues`. */
export interface FactValues {
  /** The actor knows this problem exists (makes `discovered` problems visible). */
  problem: { problemId: ProblemId; revision: number };
  /** Last seen operating status of a machine. */
  machineStatus: { status: "ok" | "degraded" | "failed" | "off"; temperatureNorm: number };
  /** Symptom noticed on a machine. */
  machineSymptom: { symptomKey: LocalKey };
  doorState: { physicalState: "closed" | "opening" | "open" | "closing" | "jammed" };
  /**
   * Last known location of an item (tool, spare, food).
   * W4a addition: `absent` marks a discrepancy: the actor looked at `location` and the item was
   * not there. The planner ignores absent items until the fact is replaced by a sighting.
   */
  itemLocation: { location: PhysicalLocation; absent?: true };
  /** Someone is known to have claimed a task. */
  taskClaim: { taskId: TaskId; claimantId: ActorId };
  /** Unexpected obstruction on a tile. */
  obstruction: { tile: TileCoord; blocked: boolean };
  /** Coarse status of another person, from sight or report. */
  actorStatus: {
    availability: Availability;
    asleep: boolean;
    /** W4a addition: tile the person was seen on (bed occupancy, chat partners). */
    tile?: TileCoord;
    /** W4a addition: seen doing nothing in particular (activity `idle`). */
    idle?: boolean;
  };
}

export type FactType = keyof FactValues;

export type EvidenceKind = "direct" | "sensor" | "report" | "inference";
export type Certainty = "confirmed" | "reported" | "suspected";

interface KnownFactBase<T extends FactType> {
  /** Entity the fact is about (machine, door, item, actor, problem, task). */
  subjectId: EntityId;
  factType: T;
  value: FactValues[T];
  /** When the observed state was true (preserved through relays, SD §13.3). */
  observedTick: Tick;
  /** When this actor learned it. */
  learnedTick: Tick;
  /** Who/what it came from: self, a sensor machine, or a reporting actor. */
  sourceId: ActorId | MachineId;
  evidence: EvidenceKind;
  certainty: Certainty;
}

export type KnownFact = { [T in FactType]: KnownFactBase<T> }[FactType];

/**
 * Key for the latest-belief table: `${subjectId}/${factType}`.
 * W0 decision: knowledge keeps only the latest belief per (subject, factType) — no history,
 * no `supersedesFactId`, no fact IDs.
 */
export type FactKey = `${string}/${FactType}`;

export type KnowledgeTable = Record<FactKey, KnownFact>;

// ---------------------------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------------------------

export interface Actor {
  id: ActorId;
  defId: CrewDefId;
  name: string;
  roleTags: RoleTag[];
  /**
   * Crew aboard are `onDeck`; a casualty being carried is `carriedBy`; NPCs at port are
   * `inExternalStore`. While moving, spatial rewrites `onDeck` x/y every tick so that it always
   * equals the position derived from `movement` (invariant); render and perception read x/y.
   */
  location: PhysicalLocation;
  movement: MovementState;
  /** Facing in radians (0 = east, clockwise positive), updated by movement; presentation hint only. */
  facing: number;
  needs: Needs;
  capacities: Capacities;
  skills: SkillLevels;
  traits: TraitDefId[];
  /** Mood in [-1, 1]; bounded effects on work and willingness (SD §11.3). */
  mood: number;
  schedule: Schedule;
  activity: Activity;
  /**
   * W2 addition: the planner's latest `Intent`, written by the planner stage (phase 7) and
   * consumed (deleted) by the work system when it turns it into a claim/action next tick.
   */
  pendingIntent?: Intent;
  /** Tick of the last planner run for this actor; drives switch cooldown and staggering. */
  lastPlannedTick: Tick;
  knowledge: KnowledgeTable;
  /** Bumped whenever navigation-relevant knowledge changes (doors, obstructions). */
  navigationKnowledgeRevision: number;
  availability: Availability;
  /**
   * W4a addition: per-candidate retry backoff, `ref` → first tick it may be retried (SD §14.7:
   * never retry a failed pickup every tick). Refs are `task:<id>`, `eat`, `sleep:<machineId>`,
   * etc. Written by work when an activity fails; expired entries are pruned by work.
   */
  workBackoff?: Record<string, Tick>;
  /** W4a addition: tick of this actor's last ambient conversation (chat cooldown). */
  lastConversationTick?: Tick;
  /**
   * Crew or NPC. W0 decision: NPC passengers are `Actor`s with `crew: false`; they never plan work.
   */
  crew: boolean;
}

/**
 * Inventory is not stored on the actor. W0 decision: an item's `location` is the single source of
 * truth for custody; "what is X carrying" is a derived index in `DerivedCaches`, so the two can
 * never disagree.
 */
export type CarriedInventory = ItemId[];
