/**
 * The work contract (SD §14–15; PLAN §6 "Problem/Task advertisement").
 *
 * ## Three layers (SD §14.1)
 *
 * - **Problem**: a durable condition needing attention, owned by the system that detects it.
 * - **Task**: a desired change derived from a problem; what the planner claims.
 * - **Action**: one bounded executable step an actor is performing now.
 *
 * ## How a system advertises work (build it exactly this way)
 *
 * 1. The *owning system* detects a condition and creates or revises a `Problem` row in
 *    `state.work.problems`. Equipment creates `machineSymptom` / `machineFault` /
 *    `maintenanceDue` / `partsNeeded`; travel/commerce creates `cargoToLoad` / `cargoToUnload` /
 *    `stationToStaff`. Before creating, it looks up an open problem with the same `dedupeKey`
 *    and bumps `revision` instead of duplicating (SD §14.2: no twenty repair jobs for one fault).
 * 2. The *work system* (W4) derives tasks from problems through the `TaskDerivationTable`: one
 *    rule per `ProblemKind`, each returning `TaskSpec`s. Each owning system exports the rules for
 *    the kinds it owns from `systems/<system>/tasks.ts` as a `Partial<TaskDerivationTable>`;
 *    `systems/work/derivation.ts` merges them and asserts every kind is covered. A task's
 *    identity is `(problemId, derivationKey)`; re-derivation after a problem revision updates
 *    the matching task in place (bumping `revision`) or cancels tasks no longer derived.
 * 3. The *planner* (phase 7) sees only the tasks whose problems the actor knows about (see
 *    `ProblemVisibility`) and returns an `Intent`. The work system turns an intent into a
 *    `Claim` and a first `Action` for the next tick.
 * 4. *Execution* (phase 3) advances actions against truth. Progress lives on the target (SD
 *    §14.4): repair stage progress is on the machine's fault; haul progress is the item's actual
 *    location. When the owning system observes the condition cleared, it sets the problem's
 *    status to `resolved`; the work system then completes/cancels its tasks and releases claims.
 *
 * Personal needs (eat, sleep, rest, socialize) are **not** problems. The planner synthesises
 * them from `AgentView.self.needs` and known amenities (SD §11.3: needs create candidates, not a
 * second planning system). W0 decision.
 */
import type { DeepReadonly, LocationRef, Seconds, Tick, TileCoord } from "./common";
import type {
  ConfigDef,
  ContentBundle,
  DockAreaKind,
  ItemCount,
  RecipeActionKind,
  SkillRequirement,
  ToolKind,
} from "./content";
import type {
  ActorId,
  ClaimId,
  DecisionId,
  DockDefId,
  DoorId,
  ItemDefId,
  ItemId,
  JobId,
  LocalId,
  LocalKey,
  MachineId,
  PortDefId,
  ProblemId,
  TaskId,
} from "./ids";
import type { WorldState } from "./state";

// ---------------------------------------------------------------------------------------------
// Urgency (SD §15.2)
// ---------------------------------------------------------------------------------------------

/** The five urgency classes, highest first. Index order is the comparison order. */
export const URGENCY_CLASSES = [
  "immediateSurvival",
  "containment",
  "essentialOperation",
  "routineObligation",
  "voluntaryActivity",
] as const;

export type UrgencyClass = (typeof URGENCY_CLASSES)[number];

// ---------------------------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------------------------

/** Which system created a problem and is responsible for resolving it. */
export type ProblemOwner = "equipment" | "travel" | "commerce";

/**
 * Who can see a problem in their AgentView.
 * W0 decision: `public` problems (cargo manifests, staffing, scheduled maintenance) are known to
 * every crew member; `discovered` problems (symptoms, diagnosed faults) are visible to an actor
 * only once they hold a `problem` KnownFact about it, written by perception or a report.
 */
export type ProblemVisibility = "public" | "discovered";

export type ProblemStatus = "open" | "resolved" | "cancelled";

/** Per-kind payloads. Add a kind here, then add its derivation rule in the owning system. */
export interface ProblemPayloads {
  /** A noticed but undiagnosed symptom. Derives an inspect/diagnose task. */
  machineSymptom: { machineId: MachineId; symptomKey: LocalKey };
  /** A diagnosed fault. Derives a repair task following the fault's `RepairRecipe`. */
  machineFault: { machineId: MachineId; faultKey: LocalKey };
  /** Routine inspection due. */
  maintenanceDue: { machineId: MachineId };
  /** A contracted item in a port store must be moved aboard to a stowage zone. */
  cargoToLoad: { jobId: JobId; itemId: ItemId; stowageZoneKey: LocalKey };
  /** A contracted item aboard must be moved into the destination port store. */
  cargoToUnload: {
    jobId: JobId;
    itemId: ItemId;
    portId: PortDefId;
    storeKey: LocalKey;
  };
  /** A station must be crewed for the current travel stage (e.g. pilot for undock → dock). */
  stationToStaff: { machineId: MachineId };
  /**
   * D47: a diagnosed fault's remaining repair steps consume `count` more of `itemDefId` than the
   * ship has aboard. Owner: equipment (it watches the shortfall); commerce derives the `buyParts`
   * task while the ship is docked at a port whose market sells it and the ship can pay.
   */
  partsNeeded: { machineId: MachineId; itemDefId: ItemDefId; count: number };
}

export type ProblemKind = keyof ProblemPayloads;

interface ProblemBase<K extends ProblemKind> {
  id: ProblemId;
  kind: K;
  payload: ProblemPayloads[K];
  owner: ProblemOwner;
  visibility: ProblemVisibility;
  /** Stable identity for dedupe, e.g. `machineFault:m4:wornBearing`. At most one open problem per key. */
  dedupeKey: string;
  status: ProblemStatus;
  createdTick: Tick;
  /** Bumped when the owning system revises the condition; tasks re-derive on change. */
  revision: number;
  /** Owner's baseline urgency hint. The planner re-evaluates from what the actor knows. */
  baseUrgency: UrgencyClass;
  location: LocationRef;
}

/** Discriminated union of all problems. Narrow on `kind`. */
export type Problem = { [K in ProblemKind]: ProblemBase<K> }[ProblemKind];
export type ProblemOfKind<K extends ProblemKind> = Extract<Problem, { kind: K }>;

// ---------------------------------------------------------------------------------------------
// Tasks (SD §14.2)
// ---------------------------------------------------------------------------------------------

export const TASK_TYPES = [
  "inspect",
  "diagnose",
  "repair",
  "haul",
  "staffStation",
  "buyParts",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type TaskStatus = "pending" | "claimed" | "active" | "blocked" | "completed" | "cancelled";

/** What the task acts on. */
export type TaskTarget =
  | { kind: "machine"; machineId: MachineId }
  | { kind: "item"; itemId: ItemId }
  | { kind: "door"; doorId: DoorId };

/**
 * Where the task's physical progress lives (SD §14.4). The task holds a reference, never the
 * progress itself, so it survives worker turnover.
 */
export type ProgressRef =
  | { kind: "fault"; machineId: MachineId; faultKey: LocalKey }
  | { kind: "maintenance"; machineId: MachineId }
  | { kind: "itemCustody"; itemId: ItemId }
  /** Staffing has no accumulated progress; it is satisfied while occupied. */
  | { kind: "occupancy"; machineId: MachineId }
  /** D47: a purchase has no accumulated progress; the units land aboard at the commit point. */
  | { kind: "market"; portId: PortDefId; itemDefId: ItemDefId; count: number };

/** SD §14.7 structured blockage reasons. */
export const BLOCKAGE_REASONS = [
  "unknownDiagnosis",
  "missingTool",
  "inaccessibleSupply",
  "unsafeKnownAtmosphere",
  "unreachableTarget",
  "insufficientCompetency",
  "occupiedPosition",
  "unavailablePower",
  "rampClosed",
  "dependencyPending",
] as const;
export type BlockageReason = (typeof BLOCKAGE_REASONS)[number];

export interface Blockage {
  reason: BlockageReason;
  sinceTick: Tick;
  retryAfterTick: Tick;
}

/** How the work system decides a task is done. Checked against truth, not animation. */
export type CompletionPredicate =
  | { kind: "problemResolved" }
  | { kind: "itemInZone"; itemId: ItemId; zoneKey: LocalKey }
  | { kind: "itemInStore"; itemId: ItemId; portId: PortDefId; storeKey: LocalKey }
  /**
   * D63: the item lies in the `area` of dock `dockId` while that dock is alongside (freight
   * delivered to the delivery bay). Custody, like the other two item kinds.
   */
  | { kind: "itemInDockArea"; itemId: ItemId; dockId: DockDefId; area: DockAreaKind }
  | { kind: "stageReached"; stageKey: LocalKey }
  /** D47: done once the plan's last step commits (a purchase); the owner settles its problem. */
  | { kind: "stepsDone" };

export type ClaimState = { kind: "unclaimed" } | { kind: "claimed"; claimIds: ClaimId[] };

export interface Task {
  id: TaskId;
  problemId: ProblemId;
  /** Distinguishes multiple tasks derived from one problem; identity is (problemId, derivationKey). */
  derivationKey: string;
  type: TaskType;
  target: TaskTarget;
  createdTick: Tick;
  revision: number;
  status: TaskStatus;
  baseUrgency: UrgencyClass;
  requiredSkills: SkillRequirement[];
  requiredTools: ToolKind[];
  consumables: ItemCount[];
  /** Max simultaneous workers. */
  workerSlots: number;
  /** Absolute tiles workers may stand on (resolved from the machine placement). */
  interactionTiles: TileCoord[];
  /** Must be completed first. Acyclic; the work system reports a cycle rather than deadlocking. */
  dependencyIds: TaskId[];
  progressRef: ProgressRef;
  blockage?: Blockage;
  claimState: ClaimState;
  completion: CompletionPredicate;
  /** Rough work estimate for SD §15.3 ranking; travel is estimated by the planner. */
  estimatedWorkSeconds: Seconds;
}

/** What a derivation rule returns; the work system fills in identity, status and bookkeeping. */
export type TaskSpec = Omit<
  Task,
  "id" | "problemId" | "createdTick" | "revision" | "status" | "blockage" | "claimState"
>;

/**
 * Read-only inputs a derivation rule may use. Truth is fine here: derivation is not planning.
 * W5 addition: `state`, so a rule can resolve its problem's machine/item instance (deck,
 * placement, existing faults) to size a task's `interactionTiles`, tools and duration — content
 * alone is not enough once the problem is about a specific instance. `DeepReadonly<WorldState>`
 * (not `ReadonlyWorldState` from `pipeline.ts`) to avoid a `work.ts` <-> `pipeline.ts` value
 * import cycle; both are `import type`-only so this is safe either way, but this keeps the
 * dependency direction the same as the rest of this file.
 */
export interface DerivationCtx {
  content: ContentBundle;
  config: ConfigDef;
  tick: Tick;
  state: DeepReadonly<WorldState>;
}

export type DeriveTasks<K extends ProblemKind> = (
  problem: ProblemOfKind<K>,
  ctx: DerivationCtx,
) => TaskSpec[];

/** One rule per problem kind; total by construction. See the module comment for ownership. */
export type TaskDerivationTable = { [K in ProblemKind]: DeriveTasks<K> };

// ---------------------------------------------------------------------------------------------
// Claims (SD §14.5)
// ---------------------------------------------------------------------------------------------

/**
 * A lease on a task slot (and optionally an interaction tile) by one actor. Renewed while the
 * actor progresses; expires at `expiresAtTick` otherwise, so an incapacitated or stuck worker
 * never holds work forever. Claims are bookkeeping, not observations: other planners learn of
 * a claim only through a `taskClaim` KnownFact.
 */
export interface Claim {
  id: ClaimId;
  taskId: TaskId;
  ownerActorId: ActorId;
  claimedTick: Tick;
  expiresAtTick: Tick;
  /** Reserved standing tile, if the task needs an exclusive position. */
  tile?: TileCoord;
}

// ---------------------------------------------------------------------------------------------
// Actions (SD §14.3): bounded state machines
// ---------------------------------------------------------------------------------------------

/**
 * Stages per action kind. An action advances through its stages under kernel control; it is
 * never an open-ended script. Add a kind by adding a key here.
 */
export interface ActionStages {
  walk: "moving" | "waitingForDoor" | "blocked";
  operateDoor: "working";
  pickUp: "reaching" | "committed";
  putDown: "placing" | "committed";
  inspect: "working";
  diagnose: "working";
  repair: "working";
  removeComponent: "working" | "committed";
  installComponent: "working" | "committed";
  test: "working";
  eat: "fetching" | "eating";
  sleep: "lyingDown" | "asleep" | "waking";
  operateStation: "operating";
  chat: "talking";
  wait: "waiting";
}

export type ActionKind = keyof ActionStages;

/** Compile-time check that every recipe action is an action kind. */
export type RecipeActionsAreActions = RecipeActionKind extends ActionKind ? true : never;

interface ActionBase<K extends ActionKind> {
  kind: K;
  stage: ActionStages[K];
  /** What the action touches (machine, item, door, other actor). Absent for `wait`/`sleep` on floor. */
  targetId?: MachineId | ItemId | DoorId | ActorId;
  /**
   * Personal progress in [0, 1] for actions whose progress belongs to the actor (eat, chat,
   * stage timers). Repair progress lives on the fault, not here (SD §14.4).
   */
  progress: number;
  startedTick: Tick;
  /** Can the planner replace this action immediately? Committed stages are not interruptible. */
  interruptible: boolean;
}

export type Action = { [K in ActionKind]: ActionBase<K> }[ActionKind];

// ---------------------------------------------------------------------------------------------
// Activity: what an actor is doing, tying intent to action
// ---------------------------------------------------------------------------------------------

/**
 * `comeAboard` (D61) is never planned: departure prep gives it to someone on the dock, a walk
 * back up the nearest ramp, so a stroll on the quay cannot hold the ship.
 *
 * D70: neither are `lookForWork` (commerce gives it to the command actor once per docking: down
 * the personnel ramp, which raises `captainAshore`, then whatever the answer calls for) and
 * `meetSpeaker` (commerce gives it to the command actor for a card held for delivery in person:
 * over to the speaker, or out through the gate, and the card comes up when they meet).
 */
export const PERSONAL_ACTIVITIES = [
  "eat",
  "sleep",
  "rest",
  "socialize",
  "wander",
  "comeAboard",
  "lookForWork",
  "meetSpeaker",
] as const;
export type PersonalActivity = (typeof PERSONAL_ACTIVITIES)[number];

/**
 * W4a addition: where a `moveTo` step goes. A tile, or a machine interaction position (resolved
 * by spatial to its absolute tile, and reserved on arrival).
 */
export type StepTarget =
  | TileCoord
  | { readonly machineId: MachineId; readonly positionKey: LocalKey };

/** W4a addition: what a `work` step does each tick. */
export type WorkStageKey =
  /** Personal timed work (eating), `ticksDone`/`ticksNeeded` on the step. */
  | "eat"
  /** A recipe stage owned by equipment (W5): progress lives on the fault/machine. */
  | "recipe"
  /** D47: time at a port market's counter before the `buy` commit step. */
  | "buy";

/** W4a addition: open-ended "stay here" stages; each ends on its own condition. */
export type HoldKind = "sleep" | "staff" | "rest" | "socialize";

/**
 * W4a addition: one step of an activity's bounded plan (SD §14.3). The work system builds the
 * plan when an intent starts and walks it one step at a time; the contract `action` mirrors the
 * current step for render/inspection.
 */
export type ActivityStep =
  | { kind: "moveTo"; target: StepTarget; requested: boolean }
  /** Take `itemId` from its believed location; `split` takes one unit off a stack. */
  | { kind: "pickUp"; itemId: ItemId; split: boolean }
  | { kind: "work"; stage: WorkStageKey; ticksDone: number; ticksNeeded: number }
  /** Eat commit point: one carried unit of `itemId` is consumed. */
  | { kind: "consume"; itemId: ItemId }
  /** Put a carried item down here (deck floor, or a port store across the cargo ramp). */
  | { kind: "putDown"; itemId: ItemId }
  /**
   * D47 commit point: buy up to `count` of `itemDefId` from the market of `portId` (the ship must
   * be docked there and the actor at the counter: a cargo transfer tile, or since D63 the dock's
   * market stall or its gate); the ship's money drops by the price. The units land on the deck
   * at the actor's feet, or with `intoHands` (D63, on the dock) in the buyer's hands, to be
   * carried aboard by the plan's `stowBought` step.
   */
  | { kind: "buy"; portId: PortDefId; itemDefId: ItemDefId; count: number; intoHands?: true }
  /**
   * D63: a dock with no market stall has its market through the gate. Standing at the gate, the
   * buyer goes out (`availability: offShip`, in the port's market store) for `ticksNeeded`, then
   * comes back to the gate tile `gate`.
   */
  | {
      kind: "throughGate";
      portId: PortDefId;
      gate: TileCoord;
      ticksDone: number;
      ticksNeeded: number;
    }
  /** D63: set down every carried unit of `itemDefId` here (bought parts, carried aboard). */
  | { kind: "stowBought"; itemDefId: ItemDefId }
  /**
   * D65: take `itemId` (a crate within reach) onto the hand truck `truckId` in the actor's hands:
   * it goes `inContainer` the truck. A crate that is not there drops its leg of the batch.
   */
  | { kind: "loadTruck"; itemId: ItemId; truckId: ItemId }
  /**
   * D65: set `itemId` down off the truck here, and settle its haul task: completed if its custody
   * predicate now holds, else released. The lead task (`Activity.taskId`) is settled at the end.
   */
  | { kind: "unloadTruck"; itemId: ItemId; truckId: ItemId }
  /** D65: set the (empty) hand truck down here, aboard. */
  | { kind: "parkTruck"; truckId: ItemId }
  /**
   * D70, `lookForWork`: standing on the dock, wait for the narrator's answer to this docking's
   * `captainAshore` ask (raised by commerce the tick the actor first stands on dock floor). Then
   * the plan goes on to whatever the answer calls for: the meeting for a card held for the
   * captain, else the look round that follows it in the plan.
   */
  | { kind: "awaitWord"; portId: PortDefId }
  /**
   * D70: talk with `withName` (a local on the dock, `localId`) for `ticksNeeded`, standing beside
   * them; the card comes up at the following `deliverCard`. Fails if they are no longer within
   * reach.
   */
  | {
      kind: "talk";
      decisionId: DecisionId;
      withName: string;
      localId: LocalId;
      ticksDone: number;
      ticksNeeded: number;
    }
  /**
   * D70 commit point: the held card `decisionId` comes up now (`deliverHeldCard`). A card already
   * delivered some other way (given up waiting, the dock leaving) makes this a no-op.
   */
  | { kind: "deliverCard"; decisionId: DecisionId }
  | { kind: "hold"; hold: HoldKind; sinceTick: Tick };

/**
 * D65: one more haul task a hand-truck trip holds, besides the activity's own (`taskId`, the
 * lead, whose crate is set down last).
 */
export interface HaulLeg {
  taskId: TaskId;
  claimId: ClaimId;
}

/**
 * D65: a haul activity moving several crates on the hand truck `truckId`. `legs` are the other
 * tasks it holds claims on; each leaves when its crate is set down (or found missing). Using the
 * truck is this record: nobody else plans with a truck that some activity names.
 */
export interface HaulBatch {
  truckId: ItemId;
  legs: HaulLeg[];
}

/** W4a addition: the steps of one activity and the current index. */
export interface ActivityPlan {
  steps: ActivityStep[];
  stepIndex: number;
}

/**
 * W0 decision: an actor's current work is one discriminated `activity` rather than nullable
 * `activeTaskId`/`activeAction` fields.
 *
 * W4a addition: `label` (short verb phrase for the render label, e.g. "hauling crate") and
 * `plan` (the bounded step list the work system executes). Both optional so hand-built
 * fixtures without them stay valid; the work system always sets them.
 */
export type Activity =
  | { kind: "idle" }
  | {
      kind: "task";
      taskId: TaskId;
      claimId: ClaimId;
      urgency: UrgencyClass;
      action: Action;
      sinceTick: Tick;
      label?: string;
      plan?: ActivityPlan;
      /** D65: a hand-truck trip; absent for every other task, a one-crate haul included. */
      haul?: HaulBatch;
    }
  | {
      kind: "personal";
      activity: PersonalActivity;
      urgency: UrgencyClass;
      action: Action;
      sinceTick: Tick;
      label?: string;
      plan?: ActivityPlan;
    };

// ---------------------------------------------------------------------------------------------
// Planner output
// ---------------------------------------------------------------------------------------------

/**
 * What the planner wants. Execution validates it against truth next tick (SD §5.2); an intent
 * is a request, not a mutation.
 */
export type Intent =
  | { kind: "continue" }
  | { kind: "idle" }
  | {
      kind: "task";
      taskId: TaskId;
      urgency: UrgencyClass;
      trace: PlannerTrace;
    }
  | {
      kind: "personal";
      activity: PersonalActivity;
      /** Amenity to use (bed, galley) or actor to chat with. */
      targetId?: MachineId | ActorId;
      /** W4a addition: the item to use (the ration stack to eat from). */
      itemId?: ItemId;
      /** W4a addition: where to go for rest/socialize (a floor tile in a mess or quarters). */
      tile?: TileCoord;
      /** D70, `meetSpeaker`: the held card the meeting delivers. */
      decisionId?: DecisionId;
      urgency: UrgencyClass;
      trace: PlannerTrace;
    };

/** SD §15.7 compact decision trace, kept in a bounded diagnostic ring (not saved). */
export interface PlannerTrace {
  candidates: number;
  chosenReason: string;
  rejected: { ref: string; reason: string }[];
}
