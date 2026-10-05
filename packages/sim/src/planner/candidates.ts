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
 * - `cargoToLoad`/`cargoToUnload`, symptom inspection (`machineSymptom`) and `maintenanceDue`
 *   → routineObligation;
 * - personal needs: above `seekThreshold` → routineObligation, above `needEssentialAbove` →
 *   essentialOperation, above `needSurvivalAbove` → immediateSurvival;
 * - rest/socialize → voluntaryActivity.
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
import type { ActorId, ItemId, MachineId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, KnownItemView, ProblemView, TaskView } from "../core/types/view";
import { backingOff, loungeTile, personal, sameTile } from "./common";
import { gangwayCandidate, helmTaskAllowed, helmTaskExempt, isHelmTask } from "./helm";
import { dutyIdleCandidate } from "./rounds";

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

const inMyHands = (view: AgentView, item: KnownItemView): boolean =>
  item.location.kind === "carriedBy" && item.location.actorId === view.self.id;

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

export function taskUrgency(
  view: AgentView,
  problem: ProblemView,
  config: PlannerConfig,
): UrgencyClass {
  switch (problem.kind) {
    case "machineFault": {
      const { machineId } = problem.payload;
      const tags = machineTags(view, machineId);
      const base: UrgencyClass =
        tags.includes("engine") || tags.includes("lifeSupport")
          ? "containment"
          : problem.baseUrgency;
      return higher(base, heatUrgency(view, machineId, config));
    }
    case "machineSymptom":
      return higher("routineObligation", heatUrgency(view, problem.payload.machineId, config));
    case "maintenanceDue":
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
  const exempt = helm && helmTaskExempt(view, task);
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

export function needUrgency(value: number, config: PlannerConfig): UrgencyClass | undefined {
  if (value > config.urgency.needSurvivalAbove) return "immediateSurvival";
  if (value > config.urgency.needEssentialAbove) return "essentialOperation";
  if (value > config.needs.seekThreshold) return "routineObligation";
  return undefined;
}

function eatCandidate(view: AgentView, config: PlannerConfig): Candidate | Rejection | undefined {
  const urgency = needUrgency(view.self.needs.hunger, config);
  if (urgency === undefined) return undefined;
  // `mealDays` in ticks, inline because the planner may not import `core/clock` (D76).
  const mealTicks = Math.ceil(
    config.needs.mealDays * config.time.daySeconds * config.time.tickRate,
  );
  const food = view.knownItems().filter((i) => i.tags.includes("food") && !i.absent);
  const table = messTile(view);
  const toTable = (from?: TileCoord): number => {
    if (table === undefined) return 0;
    return view.estimateTravelTicks(table, from) ?? 0;
  };
  const atTable = table === undefined ? {} : { tile: table };
  const inHand = food.find((i) => inMyHands(view, i));
  if (inHand !== undefined) {
    return personal("eat", urgency, toTable() + mealTicks, view.tick, {
      kind: "personal",
      activity: "eat",
      itemId: inHand.itemId,
      ...atTable,
    });
  }
  let best: { item: KnownItemView; ticks: number } | undefined;
  for (const item of food) {
    if (item.tile === undefined || backingOff(view, `eat:${item.itemId}`)) continue;
    const ticks = view.estimateTravelTicks(item.tile);
    if (ticks !== null && (best === undefined || ticks < best.ticks)) best = { item, ticks };
  }
  if (best === undefined) return { ref: "eat", reason: "noKnownFood" };
  const fetch = best.ticks + toTable(best.item.tile);
  return personal(`eat:${best.item.itemId}`, urgency, fetch + mealTicks, view.tick, {
    kind: "personal",
    activity: "eat",
    itemId: best.item.itemId,
    ...atTable,
  });
}

/**
 * W4a decision: people carry their food to the mess to eat when the ship has one (and they are
 * not already in it); otherwise they eat where they picked it up.
 */
function messTile(view: AgentView): TileCoord | undefined {
  const here = view.self.tile;
  if (
    here !== undefined &&
    (inCompartmentTagged(view, here, "mess") || inCompartmentTagged(view, here, "galley"))
  ) {
    return undefined;
  }
  return loungeTile(view, ["mess", "galley"]);
}

function inCompartmentTagged(view: AgentView, tile: TileCoord, tag: string): boolean {
  const symbol = view.schematic.deck.tiles[tile.y]?.[tile.x];
  return view.schematic.deck.compartments.some((c) => c.symbol === symbol && c.tags.includes(tag));
}

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
  const tags =
    activity === "rest" ? ["quarters", "mess", "galley"] : ["mess", "galley", "quarters"];
  const tile = loungeTile(view, tags);
  if (tile === undefined) return { ref: activity, reason: "noLounge" };
  const ticks = view.estimateTravelTicks(tile);
  if (ticks === null) return { ref: activity, reason: "unreachableTarget" };
  return personal(activity, "voluntaryActivity", ticks, view.tick, {
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
    const problems = new Map(view.knownProblems().map((p) => [p.id as string, p]));
    const tasks = view.knownTasks();
    const liveTaskIds = new Set<string>(tasks.map((t) => t.id));
    for (const task of tasks) add(taskCandidate(view, config, task, problems, liveTaskIds));
  }
  add(eatCandidate(view, config));
  add(sleepCandidate(view, config));
  add(leisureCandidate(view, config, "rest"));
  add(leisureCandidate(view, config, "socialize"));
  if (!passenger) {
    add(gangwayCandidate(view, config));
    add(dutyIdleCandidate(view, config));
  }
  return { candidates, rejected };
}

/** Is `candidate` what the actor is already doing? */
export function matchesActivity(candidate: Candidate, activity: DeepReadonly<Activity>): boolean {
  const choice = candidate.choice;
  if (activity.kind === "task") return choice.kind === "task" && choice.taskId === activity.taskId;
  if (activity.kind === "personal")
    return choice.kind === "personal" && choice.activity === activity.activity;
  return false;
}
