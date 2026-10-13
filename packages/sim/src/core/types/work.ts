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
 *    `maintenanceDue` / `partsNeeded`; travel/commerce creates `cargoToLoad` / `cargoToUnload`,
 *    travel `courseToPlot` (§course-plotting); the watch creates `stationToStaff`
 *    (§problem-ownership); commerce creates `reserveLow` (§reserve-low-problem); damage creates
 *    `machineDamaged`, `hullScar`, `hullDamaged` and `compartmentToCheck`
 *    (§hull-scars-and-ship-loss, §scouts). Before creating, it looks up an open problem with the
 *    same `dedupeKey` and bumps `revision` instead of duplicating (SD §14.2: no twenty repair jobs
 *    for one fault).
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
  DirtTier,
  DockAreaKind,
  ItemCount,
  RecipeActionKind,
  SkillRequirement,
  ToolKind,
} from "./content";
import type {
  ActivityDefId,
  ActorId,
  ClaimId,
  CompartmentId,
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
  ScarId,
  SessionId,
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

/**
 * Which system created a problem and is responsible for resolving it. The watch owns
 * `stationToStaff` (the helm's watch and relief posts), the galley owns `mealToCook` and
 * `mealToCarry`, dirt owns `compartmentDirty`, damage owns `machineDamaged`, `hullScar`,
 * `hullDamaged` and `compartmentToCheck`, and medical owns `crewWounded` (§problem-ownership).
 */
export type ProblemOwner =
  | "equipment"
  | "travel"
  | "commerce"
  | "watch"
  | "galley"
  | "dirt"
  | "damage"
  | "medical";

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
  /**
   * A station must be crewed (§who-has-the-helm: the helm). `watch` is the section's post, open
   * while a course is planned or the ship is underway; `relief` stands in for a stander away for a
   * need.
   */
  stationToStaff: { machineId: MachineId; post: "watch" | "relief" };
  /**
   * §course-plotting: a course to `toPortId` must be plotted at the nav terminal before departure.
   */
  courseToPlot: { toPortId: PortDefId };
  /**
   * §parts-and-tools-needed: a diagnosed fault's remaining repair steps consume `count` more of
   * `itemDefId` than the ship has aboard. Owner: equipment (it watches the shortfall); commerce
   * derives the `buyParts` task while the ship is docked at a port whose market sells it and the
   * ship can pay.
   */
  partsNeeded: { machineId: MachineId; itemDefId: ItemDefId; count: number };
  /**
   * §reserve-low-problem: the ship's stores of `itemDefId` are below the reserve it keeps (food in
   * days of the crew's hunger, spares in units), and the port it is docked at sells it: `count`
   * more units bring it back up. Owner: commerce, which raises it only while docked at such a port
   * and derives the same `buyParts` task `partsNeeded` does. Routine: nothing is broken yet.
   */
  reserveLow: { itemDefId: ItemDefId; count: number };
  /**
   * §meal-problem: the meal for watch `watchIndex` (`watchIndexAt`) is to be cooked and served
   * before its bell. Owner: galley (dedupe `meal:<watchIndex>`, public, routine); derives one
   * `cookMeal` task at the stove; resolved at the serve, cancelled with `mealMissed` at the grace.
   */
  mealToCook: { watchIndex: number };
  /**
   * §helm-plate: a serving is to be carried to `toActorId`, who holds the helm `machineId` and
   * cannot leave the seat. Owner: galley; derives one `carryMeal` task to the helm's standby tile.
   */
  mealToCarry: { toActorId: ActorId; machineId: MachineId };
  /**
   * §room-cleaning-problem: the room `key` (`CompartmentDef.key`, instance `compartmentId`) is at
   * `tier` (`dirty` or `filthy`). Owner: dirt (dedupe `dirty:<key>`, public); `baseUrgency`
   * routine, essential while `filthy` and the room is a galley or infirmary; revised on each tier
   * change. Derives one `cleanCompartment` task over the room's dirtiest tiles; resolved below
   * `untidy`.
   */
  compartmentDirty: { compartmentId: CompartmentId; key: LocalKey; tier: DirtTier };
  /**
   * §machine-damage (slice 5 call 21): a rock took integrity off `machineId`. Owner: damage (dedupe
   * `machineDamaged:<machineId>`, discovered, located at the machine, essential); derives one
   * `repairDamage` task; resolved when integrity is whole again. Faults are not this problem.
   */
  machineDamaged: { machineId: MachineId };
  /**
   * §hull-scars-and-ship-loss: a scar on the hull at `tile` in `compartmentId`. Owner: damage
   * (dedupe `hullScar:<scarId>`, discovered, located at the compartment; essential on alert,
   * routine after); derives `patchHull` underway and `plateHull` at port; resolved when plated.
   */
  hullScar: { scarId: ScarId; compartmentId: CompartmentId; tile: TileCoord };
  /**
   * §plating-and-kits-at-port (call 23): docked at a port that sells hull plating (`itemDefId`, a
   * `plating` item) with `count` more scars unplated than plates aboard. Owner: damage; routine;
   * derives commerce's `buyParts` task through `buySpec`.
   */
  hullDamaged: { itemDefId: ItemDefId; count: number };
  /**
   * §scouts: on alert, nobody has reported `compartmentId` since the last impact. Owner: damage
   * (dedupe `check:<compartmentId>`, public, essential); derives one `checkCompartment` task (a
   * scout walks there and perception does the rest); resolved by a report or the scout's arrival.
   */
  compartmentToCheck: { compartmentId: CompartmentId };
  /**
   * §the-wounded-problem: `actorId`, of the crew aboard, has `untreated` open wounds (stun hits
   * aside) nobody has treated. Owner: medical (dedupe `wounded:<actorId>`, public, located at the
   * medbay bed's compartment; essential while a wound bleeds, routine after); derives one
   * `treatWounds` task while a `medical` item is aboard, or, while the patient is down off the bed,
   * one `carryCasualty` (§extraction); resolved when every wound is treated.
   */
  crewWounded: { actorId: ActorId; untreated: number };
}

export type ProblemKind = keyof ProblemPayloads;

interface ProblemBase<K extends ProblemKind> {
  id: ProblemId;
  kind: K;
  payload: ProblemPayloads[K];
  owner: ProblemOwner;
  visibility: ProblemVisibility;
  /**
   * Stable identity for dedupe, e.g. `machineFault:m4:wornBearing`. At most one open problem per
   * key.
   */
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
  /** §course-plotting: plot the planned course at the `navStation` machine (`courseToPlot`). */
  "plotCourse",
  /** §cooking-and-serving: cook and serve the watch's meal at the stove (`mealToCook`). */
  "cookMeal",
  /** §helm-plate: carry a serving to the helm-stander's standby tile (`mealToCarry`). */
  "carryMeal",
  /** §mop-trips: mop a room's dirtiest tiles with the mop (`compartmentDirty`). */
  "cleanCompartment",
  /** §machine-damage: weld impact damage on a machine back to whole (`machineDamaged`). */
  "repairDamage",
  /** §patching-and-plating: weld a patch kit over a hull scar, underway (`hullScar`). */
  "patchHull",
  /** §patching-and-plating: fit a hull plate over a scar, at port (`hullScar`). */
  "plateHull",
  /** §scouts: a scout's walk to a compartment nobody has reported (`compartmentToCheck`). */
  "checkCompartment",
  /** §treatment-at-the-medbay-bed: treat a patient's wounds at the medbay bed (`crewWounded`). */
  "treatWounds",
  /** §extraction: carry a downed patient to the medbay bed (`crewWounded`). */
  "carryCasualty",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type TaskStatus = "pending" | "claimed" | "active" | "blocked" | "completed" | "cancelled";

/** What the task acts on. */
export type TaskTarget =
  | { kind: "machine"; machineId: MachineId }
  | { kind: "item"; itemId: ItemId }
  | { kind: "door"; doorId: DoorId }
  /**
   * §reserve-low-problem: a purchase for the ship's stores, at this port's market (no machine waits
   * on it).
   */
  | { kind: "market"; portId: PortDefId }
  /**
   * §room-cleaning-problem: a room to be cleaned (`cleanCompartment`); its tiles are the task's
   * `interactionTiles`.
   */
  | { kind: "compartment"; compartmentId: CompartmentId }
  /**
   * §patching-and-plating: a hull scar to patch or plate; the tiles beside it are the task's
   * `interactionTiles`.
   */
  | { kind: "scar"; scarId: ScarId }
  /**
   * §treatment-at-the-medbay-bed: a patient; the tiles beside the medbay bed are where to stand (a
   * treatment), or where the patient lies (§extraction, a carry).
   */
  | { kind: "actor"; actorId: ActorId };

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
  /**
   * §buying-parts: a purchase has no accumulated progress; the units land aboard at the commit
   * point.
   */
  | { kind: "market"; portId: PortDefId; itemDefId: ItemDefId; count: number }
  /**
   * §cooking-and-serving: a meal is served or not; the servings on the counter are the progress.
   */
  | { kind: "meal"; watchIndex: number }
  /** §dirt-grid: a room's dirt is its own progress (`WorldState.dirt.cells`). */
  | { kind: "room"; compartmentId: CompartmentId }
  /**
   * §hull-scars-and-ship-loss: a scar's own `recovered`/`patched` are its progress
   * (`WorldState.hull.scars`).
   */
  | { kind: "scar"; scarId: ScarId }
  /** §machine-damage: a damaged machine's integrity is the repair's progress. */
  | { kind: "integrity"; machineId: MachineId }
  /** §scouts: a check has no progress; the scout being there is the point. */
  | { kind: "check"; compartmentId: CompartmentId }
  /** §treatment-at-the-medbay-bed: the patient's wounds (`Wound.treatedTick`) are the progress. */
  | { kind: "wounds"; actorId: ActorId }
  /** §extraction: where the patient lies (on the bed, or not yet) is the carry's progress. */
  | { kind: "casualty"; actorId: ActorId };

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
   * §offered-freight: the item lies in the `area` of dock `dockId` while that dock is alongside
   * (freight delivered to the delivery bay). Custody, like the other two item kinds.
   */
  | { kind: "itemInDockArea"; itemId: ItemId; dockId: DockDefId; area: DockAreaKind }
  | { kind: "stageReached"; stageKey: LocalKey }
  /**
   * §buying-parts: done once the plan's last step commits (a purchase); the owner settles its
   * problem.
   */
  | { kind: "stepsDone" };

export type ClaimState = { kind: "unclaimed" } | { kind: "claimed"; claimIds: ClaimId[] };

export interface Task {
  id: TaskId;
  problemId: ProblemId;
  /**
   * Distinguishes multiple tasks derived from one problem; identity is (problemId, derivationKey).
   */
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
  /** Slice 4: an off-watch activity: waiting for the session to start, or playing. */
  recreate: "waiting" | "playing";
  /** Slice 4: a `privateTalk` in the captain's cabin. */
  confer: "talking";
  /** §reporting-damage: a report on the intercom. */
  report: "talking";
}

export type ActionKind = keyof ActionStages;

/** Compile-time check that every recipe action is an action kind. */
export type RecipeActionsAreActions = RecipeActionKind extends ActionKind ? true : never;

interface ActionBase<K extends ActionKind> {
  kind: K;
  stage: ActionStages[K];
  /**
   * What the action touches (machine, item, door, other actor). Absent for `wait`/`sleep` on floor.
   */
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
 * `comeAboard` (§calling-the-crew-aboard) is never planned: departure prep gives it to someone on
 * the dock, a walk back up the nearest ramp, so a stroll on the quay cannot hold the ship.
 *
 * §looking-for-work: neither are `lookForWork` (commerce gives it to the command actor once per
 * docking: down the personnel ramp, which raises `captainAshore`, then whatever the answer calls
 * for) and `meetSpeaker` (commerce gives it to the command actor for a card held for delivery in
 * person: over to the speaker, or out through the gate, and the card comes up when they meet).
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
  /**
   * §gangway-watch-and-rounds: the officer of the watch's rounds, and an idle on-duty engineer's
   * machine round.
   */
  "rounds",
  /** §gangway-watch-and-rounds: the section's helm-stander on gangway watch while docked. */
  "standWatch",
  /** Slice 4: an off-watch activity (`ActivityDef`), alone or in a group session. */
  "recreate",
  /** Slice 4: answering (or holding) a `privateTalk` summons in the captain's cabin. */
  "privateTalk",
  /**
   * §reporting-damage: the reporting reflex: to the nearest working intercom panel, and a report.
   */
  "report",
  /** §scouts: the officer of the watch on alert, holding the bridge. */
  "holdBridge",
  /**
   * Expeditions A1 (call 12): a party member to the arms locker, arming, and down to the ramp
   * foot. Never planned: the expedition system hands it out (`systems/expedition/muster.ts`).
   */
  "muster",
  /**
   * Expeditions A1 (call 6): in the fight. Set and driven by the combat system, which moves the
   * person itself; the planner keeps out (`continue`) and work does not step them.
   */
  "fight",
  /** §convalescing: a wounded crew member at the medbay bed, waiting to be treated. */
  "convalesce",
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
  /** §buying-parts: time at a port market's counter before the `buy` commit step. */
  | "buy"
  /**
   * §handover: taking over the helm at its standby position (counts only while someone holds the
   * seat).
   */
  | "handover"
  /** §course-plotting: plotting a course at the nav terminal. */
  | "plot"
  /** §gangway-watch-and-rounds: a stop on a round. */
  | "rounds"
  /** §cooking-and-serving: cooking at the stove (`galley/cook.ts` `runCook`). */
  | "cook"
  /** §mop-trips: mopping one tile (`dirt/clean.ts` `runMop`). */
  | "mop"
  /** §patching-and-plating: welding a patch kit over a scar (`damage/steps.ts` `runPatch`). */
  | "patch"
  /** §patching-and-plating: fitting a hull plate over a scar (`damage/steps.ts` `runPlate`). */
  | "plate"
  /** §machine-damage: repairing a machine's impact damage (`damage/steps.ts` `runMend`). */
  | "mend"
  /** §scouts: a scout's look round a compartment (`damage/steps.ts` `runCheck`). */
  | "check"
  /** §reporting-damage: a report at an intercom panel (`intercom/report.ts` `runReport`). */
  | "report"
  /** Expeditions A1: arming at the arms locker (`expedition/muster.ts` `runArm`). */
  | "arm"
  /** §treatment-at-the-medbay-bed: treating a patient's wounds (`medical/steps.ts` `runTreat`). */
  | "treat"
  /** §extraction: taking up a downed patient (`medical/carry.ts` `runLift`). */
  | "lift"
  /** §extraction: laying the carried patient on the medbay bed (`medical/carry.ts` `runLay`). */
  | "lay";

/** W4a addition: open-ended "stay here" stages; each ends on its own condition. */
export type HoldKind =
  | "sleep"
  | "staff"
  | "rest"
  | "socialize"
  | "gangway"
  | "bridge"
  /** §convalescing: a patient at the medbay bed (`medical/steps.ts` `convalesceHoldDone`). */
  | "convalesce";

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
   * §cooking-and-serving commit point: the carried crate of provisions is consumed and the watch's
   * servings spawn at the cook's feet (on the `serving` zone), each with `Item.meal`, and every
   * crew member aboard is told where they are (the mess call); `mealToCook` resolves.
   */
  | { kind: "serve" }
  /**
   * §buying-parts commit point: buy up to `count` of `itemDefId` from the market of `portId` (the
   * ship must be docked there and the actor at the counter: a cargo transfer tile, or since
   * §buying-parts the dock's market stall or its gate); the ship's money drops by the price. The
   * units land on the deck at the actor's feet, or with `intoHands` (§buying-parts, on the dock) in
   * the buyer's hands, to be carried aboard by the plan's `stowBought` step.
   */
  | { kind: "buy"; portId: PortDefId; itemDefId: ItemDefId; count: number; intoHands?: true }
  /**
   * §dock-market-and-passengers: a dock with no market stall has its market through the gate.
   * Standing at the gate, the buyer goes out (`availability: offShip`, in the port's market store)
   * for `ticksNeeded`, then comes back to the gate tile `gate`.
   */
  | {
      kind: "throughGate";
      portId: PortDefId;
      gate: TileCoord;
      ticksDone: number;
      ticksNeeded: number;
    }
  /**
   * §buying-parts: set down every carried unit of `itemDefId` here (bought parts, carried aboard).
   */
  | { kind: "stowBought"; itemDefId: ItemDefId }
  /**
   * §hand-truck-trips: take `itemId` (a crate within reach) onto the hand truck `truckId` in the
   * actor's hands: it goes `inContainer` the truck. A crate that is not there drops its leg of the
   * batch.
   */
  | { kind: "loadTruck"; itemId: ItemId; truckId: ItemId }
  /**
   * §hand-truck-trips: set `itemId` down off the truck here, and settle its haul task: completed if
   * its custody predicate now holds, else released. The lead task (`Activity.taskId`) is settled at
   * the end.
   */
  | { kind: "unloadTruck"; itemId: ItemId; truckId: ItemId }
  /** §hand-truck-trips: set the (empty) hand truck down here, aboard. */
  | { kind: "parkTruck"; truckId: ItemId }
  /**
   * §looking-for-work, `lookForWork`: standing on the dock, wait for the narrator's answer to this
   * docking's `captainAshore` ask (raised by commerce the tick the actor first stands on dock
   * floor). Then the plan goes on to whatever the answer calls for: the meeting for a card held for
   * the captain, else the look round that follows it in the plan.
   */
  | { kind: "awaitWord"; portId: PortDefId }
  /**
   * §meetings-and-visitors: talk with `withName` (a local on the dock, `localId`) for
   * `ticksNeeded`, standing beside them; the card comes up at the following `deliverCard`. Fails if
   * they are no longer within reach.
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
   * §delivery commit point: the held card `decisionId` comes up now (`deliverHeldCard`), and the
   * step stays current for the tick it came up on, so the label still says who the captain is with
   * while the card is on screen. A card already delivered some other way (given up waiting, the
   * dock leaving) makes this a no-op.
   */
  | { kind: "deliverCard"; decisionId: DecisionId; withName: string }
  | {
      kind: "hold";
      hold: HoldKind;
      sinceTick: Tick;
      /**
       * Slice 4: on a sleep hold, ticks someone awake shared the sleeper's compartment
       * (`systems/cabins/cabins.ts`); absent means 0.
       */
      disturbedTicks?: number;
    }
  /**
   * Slice 4: an off-watch activity at its venue (`systems/recreation/steps.ts` `runRecreate`).
   * On its first tick a `host` opens a session (or joins one already open for the activity
   * there), a `join` joins `sessionId`, a `solo` starts counting. `ticksNeeded` counts while
   * solo; a session member's step ends when the session does.
   */
  | {
      kind: "recreate";
      activityId: ActivityDefId;
      role: RecreateRole;
      sessionId?: SessionId;
      ticksDone: number;
      ticksNeeded: number;
    }
  /**
   * Slice 4: a `privateTalk` in the cabin (`systems/cabins/private-talk.ts` `runConfer`); counts
   * only while both are in the cabin.
   */
  | { kind: "confer"; ticksDone: number; ticksNeeded: number };

/** Slice 4: how someone takes part in an activity (`recreate` step, planner candidate). */
export type RecreateRole = "host" | "join" | "solo";

/**
 * §one-activity-several-claims: one more haul task a hand-truck trip holds, besides the activity's
 * own (`taskId`, the lead, whose crate is set down last).
 */
export interface HaulLeg {
  taskId: TaskId;
  claimId: ClaimId;
}

/**
 * §one-activity-several-claims: a haul activity moving several crates on the hand truck `truckId`.
 * `legs` are the other tasks it holds claims on; each leaves when its crate is set down (or found
 * missing). Using the truck is this record: nobody else plans with a truck that some activity
 * names.
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
      /**
       * §hand-truck-trips: a hand-truck trip; absent for every other task, a one-crate haul
       * included.
       */
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
      /** §meetings-and-visitors, `meetSpeaker`: the held card the meeting delivers. */
      decisionId?: DecisionId;
      /** Slice 4, `recreate`: the activity chosen. */
      activityId?: ActivityDefId;
      /** Slice 4, `recreate`: the open session to join. */
      sessionId?: SessionId;
      /** Slice 4, `recreate`: host, join or solo. */
      role?: RecreateRole;
      urgency: UrgencyClass;
      trace: PlannerTrace;
    };

/** SD §15.7 compact decision trace, kept in a bounded diagnostic ring (not saved). */
export interface PlannerTrace {
  candidates: number;
  chosenReason: string;
  rejected: { ref: string; reason: string }[];
}
