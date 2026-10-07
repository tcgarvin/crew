import {
  type Activity,
  type PersonalActivity,
  type TaskId,
  URGENCY_CLASSES,
  type UrgencyClass,
} from "../core/types";
/**
 * Candidate enumeration for the V1 selector (SD §15.1 steps 2–4). Pure over the `AgentView`.
 *
 * Urgency mapping (W4a brief; SD §15.2):
 * - `machineFault` on an `engine` or `lifeSupport` machine → containment; other faults keep the
 *   owner's base urgency (equipment raises them `essentialOperation`);
 * - symptom inspection and fault work escalate from the actor's *known* machine temperature
 *   (`machineStatus` fact): ≥ `heatSurvivalAbove` → immediateSurvival, ≥ `heatContainmentAbove`
 *   → containment;
 * - `stationToStaff` → essentialOperation (D77: who may take the helm is `helm.ts`'s);
 * - `courseToPlot` (D78) → essentialOperation;
 * - `partsNeeded` (D47) → the owner's base urgency (the repair it unblocks);
 * - `reserveLow` (D80) → the owner's base urgency (routine: restocking, nothing broken);
 * - `mealToCook`, `mealToCarry` (D81) → routineObligation (who may take them is `galley.ts`'s);
 * - `compartmentDirty` (D82) → the owner's base urgency (routine, essential for a filthy galley or
 *   infirmary; who may take it is `cleaning.ts`'s);
 * - `cargoToLoad`/`cargoToUnload` and symptom inspection (`machineSymptom`) → routineObligation;
 * - `maintenanceDue` (D90) → the owner's base urgency (routine, essential once badly worn);
 * - `machineDamaged`, `hullScar`, `hullDamaged`, `compartmentToCheck` (D93, D94) → the owner's
 *   base urgency (damage raises them essential on alert; who may take them is `alert.ts`'s);
 * - the reporting reflex (D94, `intercom.ts`) → containment, on alert only; the officer of the
 *   watch's bridge hold (`alert.ts`) → essentialOperation;
 * - personal needs: above `seekThreshold` → routineObligation, above `needEssentialAbove` →
 *   essentialOperation, above `needSurvivalAbove` → immediateSurvival;
 * - rest/socialize → the need's urgency as above, `voluntaryActivity` below the seek threshold
 *   (D84 tuning: a social or comfort need past the threshold is routine, so it ranks with a game
 *   off watch instead of always losing to it, and nobody comes on watch starved for company; the
 *   hold then ends when the need is met, `systems/work/steps.ts`);
 * - recreation (slice 4, `recreation.ts`) → routineObligation or voluntaryActivity off duty,
 *   voluntaryActivity on duty;
 * - a `privateTalk` summons (slice 4, `cabins.ts`) → essentialOperation.
 *
 * - on duty with nothing else to do (D77: `rounds.ts`, the post until rounds land) →
 *   voluntaryActivity; gangway watch in port (`helm.ts`) → routineObligation.
 *
 * Duty (D77, the watch bill): off duty, routine and essential tasks are not candidates
 * (emergencies, containment and above, ignore duty, SD §11.4), except cargo in port, which is all
 * hands awake. Off-duty actors rest or socialize when nothing else applies; on-duty actors only
 * socialize/rest when the need is actually high. Routine sleep is taken in one's sleep watch.
 */
import type { DeepReadonly, TileCoord } from "../core/types/common";
import type { MachineTag, ToolKind } from "../core/types/content";
import type { ActivityDefId, ActorId, ItemId, MachineId, SessionId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, KnownItemView, ProblemView, TaskView } from "../core/types/view";
import type { RecreateRole } from "../core/types/work";
import { alertCandidate, damageTaskAllowed, isDamageTask, recreationOffered } from "./alert";
import { summonsCandidate } from "./cabins";
import { cleanTaskAllowed, isCleaningTask } from "./cleaning";
import {
  backingOff,
  inCompartmentTagged,
  inMyHands,
  loungeTile,
  needUrgency,
  personal,
  sameTile,
} from "./common";
import {
  eatCandidate,
  galleyTaskAllowed,
  galleyTaskExempt,
  isGalleyTask,
  mealCallFor,
} from "./galley";
import { gangwayCandidate, helmTaskAllowed, helmTaskExempt, isHelmTask } from "./helm";
import { reportCandidate } from "./intercom";
import { recreationCandidate } from "./recreation";
import { dutyIdleCandidate } from "./rounds";

export { needUrgency } from "./common";

/** What the selector ranks. `estimateTicks` is time to useful intervention (SD §15.3 step 5). */
export interface Candidate {
  readonly ref: string;
  readonly urgency: UrgencyClass;
  readonly estimateTicks: number;
  readonly skill: number;
  /** Older first (task `createdTick`; needs use the planning tick). */
  readonly ageTick: number;
  readonly stableId: string;
  readonly choice:
    | { readonly kind: "task"; readonly taskId: TaskId }
    | {
        readonly kind: "personal";
        readonly activity: PersonalActivity;
        readonly targetId?: MachineId | ActorId;
        readonly itemId?: ItemId;
        readonly tile?: TileCoord;
        /** Slice 4, `recreate`: the activity, the session to join, and how they take part. */
        readonly activityId?: ActivityDefId;
        readonly sessionId?: SessionId;
        readonly role?: RecreateRole;
      };
}

export interface Rejection {
  readonly ref: string;
  readonly reason: string;
}

export interface CandidateSet {
  readonly candidates: Candidate[];
  readonly rejected: Rejection[];
}

export const urgencyIndex = (u: UrgencyClass): number => URGENCY_CLASSES.indexOf(u);

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

function machineTags(view: AgentView, machineId: MachineId): readonly MachineTag[] {
  return view.schematic.machines().find((m) => m.machineId === machineId)?.tags ?? [];
}

function heatUrgency(
  view: AgentView,
  machineId: MachineId,
  config: PlannerConfig,
): UrgencyClass | undefined {
  const status = view.fact(machineId, "machineStatus");
  if (status === undefined) return undefined;
  const t = status.value.temperatureNorm;
  if (t >= config.urgency.heatSurvivalAbove) return "immediateSurvival";
  if (t >= config.urgency.heatContainmentAbove) return "containment";
  return undefined;
}

function higher(a: UrgencyClass, b: UrgencyClass | undefined): UrgencyClass {
  return b !== undefined && urgencyIndex(b) < urgencyIndex(a) ? b : a;
}

/**
 * A machine whose fault or damage is containment work: the engine and life support always; on
 * alert also the generator (slice-5 integration: a generator shorted by a rock left the engine
 * dark and the ship stuck while a dozen essential patches outranked its repair on travel time,
 * and the electrician off watch slept on). Off alert a generator fault keeps its owner's class.
 */
function criticalMachine(view: AgentView, machineId: MachineId): boolean {
  const tags = machineTags(view, machineId);
  return (
    tags.includes("engine") ||
    tags.includes("lifeSupport") ||
    (tags.includes("generator") && view.alert() !== undefined)
  );
}

export function taskUrgency(
  view: AgentView,
  problem: ProblemView,
  config: PlannerConfig,
): UrgencyClass {
  switch (problem.kind) {
    case "machineFault": {
      const { machineId } = problem.payload;
      const base: UrgencyClass = criticalMachine(view, machineId)
        ? "containment"
        : problem.baseUrgency;
      return higher(base, heatUrgency(view, machineId, config));
    }
    case "machineSymptom": {
      // Slice-5 integration: on alert, a symptom on a critical machine (a rock's fault on the
      // engine) is looked at as containment, or the stuck ship waits behind every patch.
      const { machineId } = problem.payload;
      const base: UrgencyClass =
        view.alert() !== undefined && criticalMachine(view, machineId)
          ? "containment"
          : "routineObligation";
      return higher(base, heatUrgency(view, machineId, config));
    }
    case "maintenanceDue":
      // D90: routine, essential once the machine is badly worn; equipment says which.
      return problem.baseUrgency;
    case "cargoToLoad":
    case "cargoToUnload":
      return "routineObligation";
    case "stationToStaff":
      // D77: the watch post is essential and the relief post routine; the watch says which.
      return problem.baseUrgency;
    case "courseToPlot":
      return "essentialOperation";
    case "partsNeeded":
      // D47: the part gates a repair the owner already rated; buying it is as pressing as fixing.
      return problem.baseUrgency;
    case "reserveLow":
      return problem.baseUrgency;
    case "mealToCook":
    case "mealToCarry":
      // D81: a meal is routine; the call threshold decides who comes, not the class.
      return "routineObligation";
    case "compartmentDirty":
      // D82: routine, essential while a galley or infirmary is filthy; dirt says which.
      return problem.baseUrgency;
    case "machineDamaged":
      // Slice-5 integration: impact damage to a critical machine is as pressing as a fault there
      // (a knocked-out engine leaves the ship stuck in the rocks), above the scouts and patches.
      return criticalMachine(view, problem.payload.machineId) ? "containment" : problem.baseUrgency;
    case "hullScar":
    case "hullDamaged":
    case "compartmentToCheck":
      // D93, D94: essential on alert, routine after; damage says which.
      return problem.baseUrgency;
  }
}

function heldTools(view: AgentView): Set<ToolKind> {
  const out = new Set<ToolKind>();
  for (const item of view.knownItems()) {
    if (inMyHands(view, item)) {
      for (const kind of item.toolKinds) out.add(kind);
    }
  }
  return out;
}

/** Floor tile from which a believed item location can be picked up. */
function pickupTile(view: AgentView, item: KnownItemView): TileCoord | undefined {
  if (item.tile !== undefined) return item.tile;
  if (item.location.kind === "inExternalStore")
    return view.schematic.deck.docking.cargoTransferTiles[0];
  return undefined;
}

function nearestKnownTool(view: AgentView, kind: ToolKind): TileCoord | undefined {
  let best: { tile: TileCoord; ticks: number } | undefined;
  for (const item of view.knownItems()) {
    if (item.absent || !item.toolKinds.includes(kind)) continue;
    const tile = pickupTile(view, item);
    if (tile === undefined) continue;
    const ticks = view.estimateTravelTicks(tile);
    if (ticks !== null && (best === undefined || ticks < best.ticks)) best = { tile, ticks };
  }
  return best?.tile;
}

/** Where the actor must stand to work a machine task. */
function workTile(view: AgentView, task: TaskView): TileCoord | undefined {
  const first = task.interactionTiles[0];
  if (first !== undefined) return first;
  if (task.target.kind !== "machine") return undefined;
  const machineId = task.target.machineId;
  const purpose = task.type === "staffStation" || task.type === "plotCourse" ? "operate" : "repair";
  const tiles =
    view.schematic.machines().find((m) => m.machineId === machineId)?.interactionTiles ?? [];
  return (tiles.find((t) => t.purposes.includes(purpose)) ?? tiles[0])?.tile;
}

/** Travel legs (ticks) for a task, or a rejection reason. */
function taskTravel(view: AgentView, task: TaskView, problem: ProblemView): number | string {
  if (task.type === "haul") {
    if (task.target.kind !== "item") return "unreachableTarget";
    const itemId = task.target.itemId;
    const known = view.knownItems().find((i) => i.itemId === itemId && !i.absent);
    const carried = known !== undefined && inMyHands(view, known);
    const from =
      (known === undefined ? undefined : pickupTile(view, known)) ??
      (problem.location.kind === "tile"
        ? { x: problem.location.x, y: problem.location.y }
        : view.schematic.deck.docking.cargoTransferTiles[0]);
    const to = task.interactionTiles[0];
    if (from === undefined || to === undefined) return "unreachableTarget";
    const leg1 = carried ? 0 : view.estimateTravelTicks(from);
    const leg2 = view.estimateTravelTicks(to, carried ? undefined : from);
    return leg1 === null || leg2 === null ? "unreachableTarget" : leg1 + leg2;
  }
  const tile = workTile(view, task);
  if (tile === undefined) return "unreachableTarget";
  const held = heldTools(view);
  let travel = 0;
  let from: TileCoord | undefined;
  for (const kind of task.requiredTools) {
    if (held.has(kind)) continue;
    const toolTile = nearestKnownTool(view, kind);
    if (toolTile === undefined) return "missingTool";
    const leg = view.estimateTravelTicks(toolTile, from);
    if (leg === null) return "missingTool";
    travel += leg;
    from = toolTile;
  }
  const last = view.estimateTravelTicks(tile, from);
  return last === null ? "unreachableTarget" : travel + last;
}

/**
 * W4a decision (SD §15.3 step 6 across people, local only): an actor leaves a skilled task to a
 * colleague they can *see* right now (an `actorStatus` fact from the latest perception passes,
 * awake, available, idle) whose roster skill for the task's first requirement is strictly
 * higher. Only facts are used, never remote truth; once the colleague is out of sight or starts
 * something, the actor takes the task normally (so deference cannot deadlock).
 */
function deferTo(view: AgentView, config: PlannerConfig, task: TaskView): ActorId | undefined {
  const need = task.requiredSkills[0];
  if (need === undefined) return undefined;
  const mine = view.self.skills[need.skill] ?? 0;
  const fresh = view.tick - 2 * config.work.reconsiderEveryTicks;
  let best: { id: ActorId; level: number } | undefined;
  for (const colleague of view.roster()) {
    if (colleague.actorId === view.self.id) continue;
    const level = colleague.skills[need.skill] ?? 0;
    if (level <= mine || level < need.min) continue;
    const status = view.fact(colleague.actorId, "actorStatus");
    if (status === undefined || status.observedTick < fresh) continue;
    const v = status.value;
    if (v.availability !== "available" || v.asleep || v.idle !== true) continue;
    if (best === undefined || level > best.level) best = { id: colleague.actorId, level };
  }
  return best?.id;
}

function taskCandidate(
  view: AgentView,
  config: PlannerConfig,
  task: TaskView,
  problems: ReadonlyMap<string, ProblemView>,
  liveTaskIds: ReadonlySet<string>,
): Candidate | Rejection {
  const ref = `task:${task.id}`;
  const reject = (reason: string): Rejection => ({ ref, reason });
  const problem = problems.get(task.problemId);
  if (problem === undefined) return reject("unknownProblem");
  if (task.knownClaimantId !== undefined && task.workerSlots <= 1)
    return reject(`claimedBy:${task.knownClaimantId}`);
  if (backingOff(view, ref)) return reject("backoff");
  if (task.blockage !== undefined && view.tick < task.blockage.retryAfterTick)
    return reject(task.blockage.reason);
  if (task.dependencyIds.some((id) => liveTaskIds.has(id))) return reject("dependencyPending");
  for (const need of task.requiredSkills) {
    if ((view.self.skills[need.skill] ?? 0) < need.min) return reject("insufficientCompetency");
  }
  // D77: the helm's posts and the course plot are the watch's to hand out (`helm.ts`), which
  // also decides whether they skip deference and the off-duty rule.
  const helm = isHelmTask(task);
  if (helm && !helmTaskAllowed(view, task)) return reject("notMyHelm");
  // D81, D82: the galley's and the dirt's tasks have their own rules (`galley.ts`, `cleaning.ts`).
  if (isGalleyTask(task) && !galleyTaskAllowed(view, config, task, problem)) {
    return reject("notMyMeal");
  }
  if (isCleaningTask(task) && !cleanTaskAllowed(view, config, task, problem)) {
    return reject("notMyRoom");
  }
  // D93, D94: damage work has its own rules (`alert.ts`): the bridge sends scouts, never goes.
  if (isDamageTask(task) && !damageTaskAllowed(view, config, task, problem)) {
    return reject("notMyDamage");
  }
  const exempt = (helm && helmTaskExempt(view, task)) || galleyTaskExempt(view, task);
  const betterQualified = exempt ? undefined : deferTo(view, config, task);
  if (betterQualified !== undefined) return reject(`deferTo:${betterQualified}`);
  const urgency = taskUrgency(view, problem, config);
  // D77 addendum: cargo in port is all hands awake, not the watch's: nobody off duty is turned
  // away from a crate (the sleeping sleep on, since the hold is not interrupted for routine work).
  const allHands = problem.kind === "cargoToLoad" || problem.kind === "cargoToUnload";
  if (
    !exempt &&
    !allHands &&
    !view.self.onDuty &&
    urgencyIndex(urgency) > urgencyIndex("containment")
  )
    return reject("offDuty");
  const travel = taskTravel(view, task, problem);
  if (typeof travel === "string") return reject(travel);
  const skill = task.requiredSkills[0];
  return {
    ref,
    urgency,
    estimateTicks: travel + Math.ceil(task.estimatedWorkSeconds * config.time.tickRate),
    skill: skill === undefined ? 0 : (view.self.skills[skill.skill] ?? 0),
    ageTick: task.createdTick,
    stableId: task.id,
    choice: { kind: "task", taskId: task.id },
  };
}

// ---------------------------------------------------------------------------------------------
// Personal needs
// ---------------------------------------------------------------------------------------------

/** Berths the actor has seen someone asleep on (latest sighting). */
function occupiedTiles(view: AgentView): TileCoord[] {
  const out: TileCoord[] = [];
  for (const fact of view.facts()) {
    if (fact.factType !== "actorStatus" || fact.subjectId === view.self.id) continue;
    if (fact.value.asleep && fact.value.tile !== undefined) out.push(fact.value.tile);
  }
  return out;
}

interface BedChoice {
  readonly bed: MachineId;
  readonly ticks: number;
  readonly own: boolean;
  readonly quarters: boolean;
}

/** Own berth first, then a bunk in the quarters, then the nearest. */
const betterBed = (a: BedChoice, b: BedChoice | undefined): boolean =>
  b === undefined ||
  (a.own !== b.own ? a.own : a.quarters !== b.quarters ? a.quarters : a.ticks < b.ticks);

/**
 * D74: sleep in one's own berth (`self.berth`) unless it is believed occupied, unreachable or
 * backing off; otherwise in the unassigned pool, a quarters bunk before a nearer bed elsewhere.
 * A bed assigned to someone else is never chosen, nor a `medBed` (the infirmary bed is for
 * patients).
 *
 * D77 (addendum): routine tiredness is slept off in one's sleep watch, the watch after one's own
 * (`watch.sleepWatch`), and there anyone past bedtime (fatigue above `needs.bedtimeAbove`) turns
 * in, so a sleep a day sits in the same window every day ("Priya sleeps after her watch") instead
 * of drifting with the fatigue rate. Outside it only pressing fatigue sends them, through relief
 * at the helm.
 */
function sleepCandidate(view: AgentView, config: PlannerConfig): Candidate | Rejection | undefined {
  const fatigue = view.self.needs.fatigue;
  const urgency = sleepUrgency(view, config, fatigue);
  if (urgency === undefined) return undefined;
  // D81: dinner before bed. Bedtime (routine) waits while the mess call stands, so the off-going
  // section eats the meal served before its bell instead of sleeping through the plate's life
  // and waking to rations; pressing tiredness still sleeps.
  if (urgency === "routineObligation" && mealCallFor(view, config) !== undefined) {
    return { ref: "sleep", reason: "mealCall" };
  }
  const occupied = occupiedTiles(view);
  const mine = view.self.berth?.machineId;
  const assigned = new Set(view.assignedBeds());
  let best: BedChoice | undefined;
  for (const bed of view.schematic.amenities("bed")) {
    if (bed.tags.includes("medBed")) continue;
    const own = bed.machineId === mine;
    if (!own && assigned.has(bed.machineId)) continue;
    const berth = (
      bed.interactionTiles.find((t) => t.purposes.includes("use")) ?? bed.interactionTiles[0]
    )?.tile;
    if (berth === undefined || backingOff(view, `sleep:${bed.machineId}`)) continue;
    if (occupied.some((t) => sameTile(t, berth))) continue;
    const ticks = view.estimateTravelTicks(berth);
    if (ticks === null) continue;
    const choice = {
      bed: bed.machineId,
      ticks,
      own,
      quarters: inCompartmentTagged(view, berth, "quarters"),
    };
    if (betterBed(choice, best)) best = choice;
  }
  if (best === undefined) return { ref: "sleep", reason: "noFreeBed" };
  return personal(`sleep:${best.bed}`, urgency, best.ticks, view.tick, {
    kind: "personal",
    activity: "sleep",
    targetId: best.bed,
  });
}

/**
 * How pressing a sleep is: pressing tiredness (past `needEssentialAbove`) anywhere; routine
 * tiredness, and bedtime (fatigue past `needs.bedtimeAbove`), only in the sleep watch; nothing
 * otherwise.
 */
export function sleepUrgency(
  view: Pick<AgentView, "self">,
  config: PlannerConfig,
  fatigue: number,
): UrgencyClass | undefined {
  const urgency = needUrgency(fatigue, config);
  if (urgency !== undefined && urgency !== "routineObligation") return urgency;
  if (view.self.watch.sleepWatch !== true) return undefined;
  return fatigue > config.needs.bedtimeAbove ? "routineObligation" : undefined;
}

function leisureCandidate(
  view: AgentView,
  config: PlannerConfig,
  activity: "rest" | "socialize",
): Candidate | Rejection | undefined {
  const need = activity === "rest" ? view.self.needs.comfort : view.self.needs.social;
  if (view.self.onDuty && need <= config.needs.seekThreshold) return undefined;
  if (backingOff(view, activity)) return { ref: activity, reason: "backoff" };
  // Slice 4 (call 16): rest and chat in the lounge, so idlers leave the bunkroom.
  const tags = activity === "rest" ? ["lounge", "mess", "quarters"] : ["lounge", "mess"];
  const tile = loungeTile(view, tags);
  if (tile === undefined) return { ref: activity, reason: "noLounge" };
  const ticks = view.estimateTravelTicks(tile);
  if (ticks === null) return { ref: activity, reason: "unreachableTarget" };
  return personal(activity, needUrgency(need, config) ?? "voluntaryActivity", ticks, view.tick, {
    kind: "personal",
    activity,
    tile,
  });
}

// ---------------------------------------------------------------------------------------------

export function enumerateCandidates(view: AgentView, config: PlannerConfig): CandidateSet {
  const candidates: Candidate[] = [];
  const rejected: Rejection[] = [];
  // Passengers §3.5: one walking off the ship wants nothing else (commerce drives the walk).
  if (view.self.disembarking === true) return { candidates, rejected };
  const add = (result: Candidate | Rejection | undefined) => {
    if (result === undefined) return;
    if ("reason" in result) rejected.push(result);
    else candidates.push(result);
  };
  // Passengers §3.2: a passenger eats, sleeps and socialises like anyone aboard but never plans
  // work and has no post.
  const passenger = view.self.passenger === true;
  if (!passenger) {
    // Slice 4: a summons ranks with its class (essential), so it goes before the task loop.
    add(summonsCandidate(view, config));
    // D94: the reporting reflex (containment) likewise.
    add(reportCandidate(view, config));
    const problems = new Map(view.knownProblems().map((p) => [p.id as string, p]));
    const tasks = view.knownTasks();
    const liveTaskIds = new Set<string>(tasks.map((t) => t.id));
    for (const task of tasks) add(taskCandidate(view, config, task, problems, liveTaskIds));
  }
  add(eatCandidate(view, config));
  add(sleepCandidate(view, config));
  add(leisureCandidate(view, config, "rest"));
  add(leisureCandidate(view, config, "socialize"));
  // D92: no recreation on alert (`alert.ts`).
  if (recreationOffered(view)) add(recreationCandidate(view, config));
  if (!passenger) {
    add(gangwayCandidate(view, config));
    add(dutyIdleCandidate(view, config));
    // D94: the officer of the watch holds the bridge on alert.
    add(alertCandidate(view, config));
  }
  return { candidates, rejected };
}

/** Is `candidate` what the actor is already doing? */
export function matchesActivity(candidate: Candidate, activity: DeepReadonly<Activity>): boolean {
  const choice = candidate.choice;
  if (activity.kind === "task") return choice.kind === "task" && choice.taskId === activity.taskId;
  if (activity.kind !== "personal") return false;
  if (choice.kind !== "personal" || choice.activity !== activity.activity) return false;
  // Slice 4: one recreation is not another (cards is not the same as reading).
  if (choice.activity === "recreate") return recreatingActivity(activity) === choice.activityId;
  return true;
}

/** The activity a `recreate` plan is for (its `recreate` step's). */
function recreatingActivity(
  activity: Extract<DeepReadonly<Activity>, { kind: "personal" }>,
): ActivityDefId | undefined {
  const step = activity.plan?.steps.find((s) => s.kind === "recreate");
  return step?.kind === "recreate" ? step.activityId : undefined;
}
