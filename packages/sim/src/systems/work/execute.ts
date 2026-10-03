import { rebuildItemIndexes } from "../../core/caches";
/**
 * Action execution (SD §14.3–14.7), phase 3 after spatial movement, every tick.
 *
 * Each crew actor's `pendingIntent` (written by the planner last tick) is turned into a claim and
 * a bounded plan (`plans.ts`); the plan's current step is then advanced against truth. A step
 * either finishes (the next one starts the same tick), waits, or fails with a structured
 * `BlockageReason`. A failure records a retry backoff on the actor (and, for task-level causes,
 * on the task) so nothing is retried every tick, releases the claim, drops hauled cargo where the
 * actor stands, and leaves the actor idle for the planner to pick something else.
 *
 * W4a decisions:
 * - Recipe stages (inspect/diagnose, repair, maintain) are driven through equipment's
 *   `advanceStage` (W5), injected as a `StageExecutor` so tests can stub it. Work per tick is
 *   `manipulation × trait workSpeed × (1 + workSpeedPerSkillLevel × levels above the task's
 *   first skill requirement)` ticks of recipe progress.
 * - Eating takes one unit off the believed stack at pickup (split into a carried unit of 1) and
 *   consumes it at the end of `mealSeconds`: the stack on the floor drops by exactly one. Hunger
 *   falls by the item's `nutrition` (food without one fully satisfies).
 * - Sleep ends after `sleepMinSeconds` once fatigue ≤ `wakeBelow`, or once the actor's shift has
 *   started and fatigue is below `seekThreshold`. Rest/socialize holds end when their need is
 *   fully met while on duty; off duty they last until the planner finds something more urgent.
 * - Staffing holds until the station's problem is resolved *and* the ship is docked or in
 *   transit (the stages where travel does not check staffing), so the pilot does not walk off
 *   the moment `stationToStaff` resolves. TODO(W6): replace with an explicit "station released"
 *   signal from travel if one is added.
 * - A route that ended early (`movement.routeFailure`, W3's "replan now") fails the step:
 *   `positionTaken` → `occupiedPosition`, anything else → `unreachableTarget`.
 */
import { configTicks } from "../../core/clock";
import { marketCounter } from "../../core/docks";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { TaskReleaseReason } from "../../core/types/events";
import type { ActorId, ItemId, MachineId, PortDefId, TaskId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type {
  Action,
  ActionKind,
  ActionStages,
  Activity,
  ActivityStep,
  BlockageReason,
  Intent,
  StepTarget,
  Task,
} from "../../core/types/work";
import { buyFromMarket, marketStoreLocation, setDownBought } from "../commerce/market";
import type { RecipeCtx, RecipeOutcome } from "../equipment/recipes";
import { advanceStage } from "../equipment/recipes";
import { isOnDuty } from "../needs/shifts";
import { compartmentAt } from "../spatial/geometry";
import { requestMove, stopMovement } from "../spatial/movement";
import { releaseReservations } from "../spatial/reservations";
import { backoffRef, currentHold, currentStep, isOutThroughGate } from "./activity";
import { claimTask, completeTask, isCompletionMet, releaseActorClaim, renewClaim } from "./claims";
import { claimantsOf, isTerminal } from "./derivation";
import { directSight, writeFact } from "./facts";
import { labelFor } from "./labels";
import { believedLocation, buildPersonalPlan, buildTaskPlan, carriedItems, tileOf } from "./plans";

/** Drives recipe stages owned by equipment (W5). */
export interface StageExecutor {
  advance(ctx: RecipeCtx, taskId: TaskId, actorId: ActorId, ticks: number): RecipeOutcome;
}

export const equipmentStages: StageExecutor = { advance: advanceStage };

export interface WorkDeps {
  readonly stages: StageExecutor;
}

type StepResult = "done" | "wait" | { readonly fail: BlockageReason };

/** Bound on step transitions per actor per tick (plans are short; this only guards bugs). */
const MAX_STEPS_PER_TICK = 8;

/** Blockages that are about the task, not about this actor, so every candidate backs off. */
const TASK_LEVEL: ReadonlySet<BlockageReason> = new Set([
  "missingTool",
  "inaccessibleSupply",
  "rampClosed",
  "unknownDiagnosis",
  "dependencyPending",
]);

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function touchInventory(ctx: StepCtx): void {
  ctx.dirty.inventory = true;
  rebuildItemIndexes(ctx.state, ctx.caches.index);
}

function actorTile(actor: Actor): TileCoord | undefined {
  return actor.location.kind === "onDeck" ? tileOf(actor.location) : undefined;
}

function resolveTile(ctx: StepCtx, actor: Actor, target: StepTarget): TileCoord | undefined {
  if (!("machineId" in target)) return target;
  if (actor.location.kind !== "onDeck") return undefined;
  return ctx.caches.nav.decks[actor.location.deckId]?.interactionPositions.find(
    (p) => p.machineId === target.machineId && p.key === target.positionKey,
  )?.tile;
}

const near = (a: TileCoord, b: TileCoord): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

function onTransferTile(ctx: StepCtx, actor: Actor): boolean {
  const here = actorTile(actor);
  if (here === undefined || actor.location.kind !== "onDeck") return false;
  const deck = ctx.content.decks[actor.location.deckId];
  return deck?.docking.cargoTransferTiles.some((t) => near(t, here)) ?? false;
}

function dockedAt(ctx: StepCtx, portId: string): boolean {
  return ctx.state.travel.stage === "docked" && ctx.state.travel.portId === portId;
}

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

/** D47/D63: is the actor where `portId`'s market is dealt with (`marketCounter`)? */
function atMarketCounter(ctx: StepCtx, actor: Actor, portId: PortDefId): boolean {
  const counter = marketCounter(ctx.content, ctx.state, portId);
  if (counter.kind === "transferTile") return onTransferTile(ctx, actor);
  const here = actorTile(actor);
  return here !== undefined && near(here, counter.tile);
}

/** The step the actor is on is a walk out through the gate (D63), and they are out now. */
function gateErrand(actor: Actor): StepOf<"throughGate"> | undefined {
  const step = currentStep(actor.activity);
  return step?.kind === "throughGate" && isOutThroughGate(actor)
    ? (step as StepOf<"throughGate">)
    : undefined;
}

/**
 * D63: out through the gate on a market errand. The buyer leaves the map into the port's market
 * store and is off ship (so the planner, needs and the dock leave them be) until the step brings
 * them back.
 */
function stepOutThroughGate(ctx: StepCtx, actor: Actor, portId: PortDefId): void {
  releaseReservations(ctx.caches, actor.id);
  actor.movement = { kind: "stationary" };
  actor.location = marketStoreLocation(ctx.defs.port(portId));
  actor.availability = "offShip";
}

/**
 * Back through the gate onto the dock at `gate`. Travel never casts the dock off while someone is
 * out on an errand (it waits for them, or ends the errand first, `systems/travel/ashore.ts`), so
 * the dock is there to come back to; anything else is a broken invariant.
 */
export function stepBackThroughGate(ctx: StepCtx, actor: Actor, gate: TileCoord): void {
  const presence = ctx.state.deck.dock;
  if (presence === undefined) {
    throw new Error(`${actor.id} is out through the gate with no dock alongside to come back to`);
  }
  actor.location = { kind: "onDeck", deckId: presence.deckId, x: gate.x + 0.5, y: gate.y + 0.5 };
  actor.availability = "available";
}

/** End a gate errand early (recall, abort): the buyer comes straight back to the gate. */
export function endGateErrand(ctx: StepCtx, actor: Actor): void {
  const errand = gateErrand(actor);
  if (errand !== undefined) stepBackThroughGate(ctx, actor, errand.gate);
}

function backoffTicks(ctx: StepCtx): number {
  return configTicks(ctx.config, ctx.config.work.retryBackoffSeconds);
}

function setBackoff(ctx: StepCtx, actor: Actor, ref: string): void {
  actor.workBackoff = { ...(actor.workBackoff ?? {}), [ref]: ctx.tick + backoffTicks(ctx) };
}

function pruneBackoff(ctx: StepCtx, actor: Actor): void {
  const backoff = actor.workBackoff;
  if (backoff === undefined) return;
  const live = Object.entries(backoff).filter(([, until]) => until > ctx.tick);
  if (live.length === Object.keys(backoff).length) return;
  if (live.length === 0) {
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete actor.workBackoff;
  } else {
    actor.workBackoff = Object.fromEntries(live);
  }
}

/** Backoff ref for the actor's current activity (see `Actor.workBackoff`). */
export function activityRef(activity: Activity): string {
  if (activity.kind === "idle") return "idle";
  if (activity.kind === "task") return backoffRef.task(activity.taskId);
  const steps = activity.plan?.steps ?? [];
  if (activity.activity === "eat") {
    const pickUp = steps.find((s) => s.kind === "pickUp");
    return backoffRef.personal("eat", pickUp?.kind === "pickUp" ? pickUp.itemId : undefined);
  }
  if (activity.activity === "sleep") {
    const move = steps.find((s) => s.kind === "moveTo");
    const bed =
      move?.kind === "moveTo" && "machineId" in move.target ? move.target.machineId : undefined;
    return backoffRef.personal("sleep", bed);
  }
  return backoffRef.personal(activity.activity);
}

// ---------------------------------------------------------------------------------------------
// Actions (render/inspector mirror of the current step)
// ---------------------------------------------------------------------------------------------

function makeAction<K extends ActionKind>(
  kind: K,
  stage: ActionStages[K],
  tick: number,
  targetId?: Action["targetId"],
): Action {
  const action = { kind, stage, progress: 0, startedTick: tick, interruptible: true } as Action;
  return targetId === undefined ? action : ({ ...action, targetId } as Action);
}

const RECIPE_ACTION: Readonly<Record<string, "inspect" | "diagnose" | "repair">> = {
  inspect: "diagnose",
  maintain: "inspect",
  repair: "repair",
};

function actionFor(
  ctx: StepCtx,
  activity: Exclude<Activity, { kind: "idle" }>,
  step: ActivityStep,
): Action {
  const tick = ctx.tick;
  switch (step.kind) {
    case "moveTo":
      return makeAction("walk", "moving", tick);
    case "pickUp":
      return makeAction("pickUp", "reaching", tick, step.itemId);
    case "putDown":
      return makeAction("putDown", "placing", tick, step.itemId);
    case "consume":
      return makeAction("eat", "eating", tick, step.itemId);
    case "buy":
      return makeAction("pickUp", "reaching", tick);
    case "throughGate":
      return makeAction("wait", "waiting", tick);
    case "stowBought":
      return makeAction("putDown", "placing", tick);
    case "work": {
      if (step.stage === "eat") return makeAction("eat", "eating", tick);
      if (step.stage === "buy") return makeAction("wait", "waiting", tick);
      const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
      const kind = RECIPE_ACTION[task?.derivationKey ?? ""] ?? "repair";
      const machineId = task?.target.kind === "machine" ? task.target.machineId : undefined;
      return makeAction(kind, "working", tick, machineId);
    }
    case "hold": {
      if (step.hold === "sleep") return makeAction("sleep", "asleep", tick);
      if (step.hold === "rest") return makeAction("wait", "waiting", tick);
      if (step.hold === "socialize") return makeAction("chat", "talking", tick);
      const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
      const machineId = task?.target.kind === "machine" ? task.target.machineId : undefined;
      return makeAction("operateStation", "operating", tick, machineId);
    }
  }
}

function refreshPresentation(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind === "idle") return;
  const step = activity.plan?.steps[activity.plan.stepIndex];
  if (step !== undefined) {
    const next = actionFor(ctx, activity, step);
    const current = activity.action;
    if (
      current.kind !== next.kind ||
      current.stage !== next.stage ||
      current.targetId !== next.targetId
    ) {
      activity.action = next;
      ctx.emit({
        type: "actionStarted",
        subjectIds: [actor.id],
        causeIds: [],
        source: "sim",
        payload: { action: next.kind },
      });
    }
    if (step.kind === "work" && step.stage === "eat" && step.ticksNeeded > 0) {
      activity.action.progress = Math.min(1, step.ticksDone / step.ticksNeeded);
    }
  }
  const label = labelFor(ctx, actor);
  if (activity.label !== label) activity.label = label;
}

// ---------------------------------------------------------------------------------------------
// Ending activities
// ---------------------------------------------------------------------------------------------

/**
 * D63: a buyer stopped while carrying bought units aboard sets them down where they stand
 * (possibly on the dock, where they still count as within reach while docked).
 */
function dropBought(ctx: StepCtx, actor: Actor, task: Task): void {
  if (task.type !== "buyParts" || task.progressRef.kind !== "market") return;
  if (actor.location.kind !== "onDeck") return;
  setDownBought(ctx, actor, task.progressRef.itemDefId);
}

/** Put hauled cargo down exactly where the actor is (SD §14.6: no teleporting). */
function dropHaulCargo(ctx: StepCtx, actor: Actor, task: Task): void {
  dropBought(ctx, actor, task);
  if (task.type !== "haul" || task.target.kind !== "item") return;
  const item = ctx.state.items[task.target.itemId];
  if (
    item === undefined ||
    item.location.kind !== "carriedBy" ||
    item.location.actorId !== actor.id
  )
    return;
  if (actor.location.kind !== "onDeck") return;
  const { deckId, x, y } = actor.location;
  item.location = { kind: "onDeck", deckId, x, y };
  writeFact(
    actor,
    item.id,
    "itemLocation",
    { location: item.location },
    directSight(actor, ctx.tick),
  );
  touchInventory(ctx);
}

/**
 * Set down the tools and consumables the actor picked up for a task they are giving up, where
 * they stand: carried on, the ship's only spares (or wrench) would be out of everyone else's
 * reach until this actor happened to take the task up again.
 */
function dropTaskSupplies(ctx: StepCtx, actor: Actor, task: Task): void {
  if (task.consumables.length === 0 && task.requiredTools.length === 0) return;
  if (actor.location.kind !== "onDeck") return;
  const { deckId, x, y } = actor.location;
  const consumed = new Set(task.consumables.map((need) => need.itemDefId));
  let dropped = false;
  for (const item of carriedItems(ctx, actor.id)) {
    const def = ctx.content.items[item.defId];
    const tool = def?.toolKinds.some((kind) => task.requiredTools.includes(kind)) ?? false;
    if (!consumed.has(item.defId) && !tool) continue;
    item.location = { kind: "onDeck", deckId, x, y };
    writeFact(
      actor,
      item.id,
      "itemLocation",
      { location: item.location },
      directSight(actor, ctx.tick),
    );
    dropped = true;
  }
  if (dropped) touchInventory(ctx);
}

function leaveHold(ctx: StepCtx, actor: Actor): void {
  if (currentHold(actor.activity) === "sleep") {
    ctx.emit({ type: "wokeUp", subjectIds: [actor.id], causeIds: [], source: "sim", payload: {} });
  }
}

/** Stop whatever the actor is doing, releasing its claim. Safe to call when idle. */
export function abortActivity(ctx: StepCtx, actor: Actor, reason: TaskReleaseReason): void {
  const activity = actor.activity;
  if (activity.kind === "idle") return;
  // D63: nobody is left out through the gate by an errand that stopped.
  endGateErrand(ctx, actor);
  if (actor.movement.kind === "moving") stopMovement(ctx.state, ctx.caches, actor.id);
  else releaseReservations(ctx.caches, actor.id);
  leaveHold(ctx, actor);
  if (activity.kind === "task") {
    const task = ctx.state.work.tasks[activity.taskId];
    if (task !== undefined) {
      dropHaulCargo(ctx, actor, task);
      if (!isTerminal(task)) {
        dropTaskSupplies(ctx, actor, task);
        releaseActorClaim(ctx, actor.id, task, reason);
      }
    }
  }
  actor.activity = { kind: "idle" };
}

function failActivity(ctx: StepCtx, actor: Actor, reason: BlockageReason): void {
  const activity = actor.activity;
  if (activity.kind === "idle") return;
  ctx.emit({
    type: "actionFailed",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    payload: { action: activity.action.kind, reason },
  });
  setBackoff(ctx, actor, activityRef(activity));
  if (activity.kind === "task") {
    const task = ctx.state.work.tasks[activity.taskId];
    if (task !== undefined) blockTask(ctx, actor, task, reason);
  }
  abortActivity(ctx, actor, "failed");
}

function blockTask(ctx: StepCtx, actor: Actor, task: Task, reason: BlockageReason): void {
  ctx.emit({
    type: "taskBlocked",
    subjectIds: [actor.id, task.id],
    causeIds: [],
    source: "sim",
    payload: { taskId: task.id, reason },
  });
  if (TASK_LEVEL.has(reason)) {
    task.blockage = { reason, sinceTick: ctx.tick, retryAfterTick: ctx.tick + backoffTicks(ctx) };
  }
}

/** The plan ran out of steps. */
function finishActivity(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind === "task") {
    const task = ctx.state.work.tasks[activity.taskId];
    if (task !== undefined && !isTerminal(task)) {
      if (isCompletionMet(ctx.state, ctx.content, task)) completeTask(ctx, task);
      else releaseActorClaim(ctx, actor.id, task, "failed");
    }
  }
  actor.activity = { kind: "idle" };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function runMove(ctx: StepCtx, actor: Actor, step: StepOf<"moveTo">): StepResult {
  const tile = resolveTile(ctx, actor, step.target);
  if (tile === undefined) return { fail: "unreachableTarget" };
  if (!step.requested) {
    step.requested = true;
    if (!requestMove(ctx.state, actor.id, step.target, ctx.caches, ctx.config)) {
      return { fail: "unreachableTarget" };
    }
  }
  const movement = actor.movement;
  if (movement.kind === "moving") return "wait";
  const here = actorTile(actor);
  if (here !== undefined && here.x === tile.x && here.y === tile.y) return "done";
  if (movement.routeFailure !== undefined) {
    return {
      fail:
        movement.routeFailure.reason === "positionTaken" ? "occupiedPosition" : "unreachableTarget",
    };
  }
  // Stopped short without a failure (e.g. an interrupted walk): ask again next tick.
  step.requested = false;
  return "wait";
}

/** Record what the actor now believes after looking for `itemId` and not finding it in reach. */
function noteDiscrepancy(ctx: StepCtx, actor: Actor, itemId: ItemId): void {
  const item = ctx.state.items[itemId];
  const location = actor.location;
  const geometry = location.kind === "onDeck" ? ctx.caches.nav.decks[location.deckId] : undefined;
  if (
    item !== undefined &&
    item.location.kind === "onDeck" &&
    geometry !== undefined &&
    location.kind === "onDeck"
  ) {
    const here = compartmentAt(geometry, location.x, location.y);
    if (here !== undefined && compartmentAt(geometry, item.location.x, item.location.y) === here) {
      writeFact(
        actor,
        itemId,
        "itemLocation",
        { location: item.location },
        directSight(actor, ctx.tick),
      );
      return;
    }
  }
  const believed = believedLocation(actor, itemId);
  if (believed !== undefined) {
    writeFact(
      actor,
      itemId,
      "itemLocation",
      { location: believed, absent: true },
      directSight(actor, ctx.tick),
    );
  }
}

function takeItem(ctx: StepCtx, actor: Actor, item: Item, split: boolean): ItemId {
  if (split && item.stacking === "stack" && item.count - item.reserved > 1) {
    const id = allocateId(ctx.state, "item");
    item.count -= 1;
    ctx.state.items[id] = {
      id,
      defId: item.defId,
      stacking: "stack",
      count: 1,
      reserved: 0,
      location: { kind: "carriedBy", actorId: actor.id },
      // The split-off unit is still freight for the same job (see `ItemBase.jobId`); dropping it
      // here would un-attribute the crate mid-haul (jobs.ts `deliveryComplete`/`raiseUnloadProblems`
      // key off `job.cargoItemIds`, which already names this new id, not `jobId` on the item, but
      // other freight-aware code — inspection, the crate renderer — reads `item.jobId`).
      ...(item.jobId === undefined ? {} : { jobId: item.jobId }),
    };
    return id;
  }
  item.location = { kind: "carriedBy", actorId: actor.id };
  return item.id;
}

function runPickUp(ctx: StepCtx, actor: Actor, step: StepOf<"pickUp">): StepResult {
  const item = ctx.state.items[step.itemId];
  if (
    item !== undefined &&
    item.location.kind === "carriedBy" &&
    item.location.actorId === actor.id
  ) {
    return "done";
  }
  const here = actorTile(actor);
  if (item === undefined || here === undefined || actor.location.kind !== "onDeck") {
    noteDiscrepancy(ctx, actor, step.itemId);
    return { fail: "inaccessibleSupply" };
  }
  const location = item.location;
  let reachable = false;
  if (location.kind === "onDeck") {
    reachable = location.deckId === actor.location.deckId && near(tileOf(location), here);
  } else if (location.kind === "inExternalStore") {
    if (!onTransferTile(ctx, actor)) {
      noteDiscrepancy(ctx, actor, step.itemId);
      return { fail: "inaccessibleSupply" };
    }
    if (!dockedAt(ctx, location.portId)) return { fail: "rampClosed" };
    reachable = true;
  }
  if (!reachable) {
    noteDiscrepancy(ctx, actor, step.itemId);
    return { fail: "inaccessibleSupply" };
  }
  const takenId = takeItem(ctx, actor, item, step.split);
  if (takenId !== item.id) {
    // Later steps (the meal's consume) refer to the unit actually in hand.
    const activity = actor.activity;
    for (const later of activity.kind === "idle" ? [] : (activity.plan?.steps ?? [])) {
      if (later.kind === "consume" && later.itemId === item.id) later.itemId = takenId;
    }
    writeFact(
      actor,
      item.id,
      "itemLocation",
      { location: item.location },
      directSight(actor, ctx.tick),
    );
  }
  writeFact(
    actor,
    takenId,
    "itemLocation",
    { location: { kind: "carriedBy", actorId: actor.id } },
    directSight(actor, ctx.tick),
  );
  touchInventory(ctx);
  return "done";
}

function workRate(ctx: StepCtx, actor: Actor, task: Task): number {
  const requirement = task.requiredSkills[0];
  const levelsAbove =
    requirement === undefined
      ? 0
      : Math.max(0, (actor.skills[requirement.skill] ?? 0) - requirement.min);
  let trait = 1;
  for (const traitId of actor.traits) trait *= ctx.defs.trait(traitId).modifiers.workSpeed ?? 1;
  const skill = 1 + ctx.config.work.workSpeedPerSkillLevel * levelsAbove;
  return Math.max(0, actor.capacities.manipulation) * trait * skill;
}

function hasTools(ctx: StepCtx, actor: Actor, task: Task): boolean {
  const carried = carriedItems(ctx, actor.id);
  return task.requiredTools.every((kind) =>
    carried.some((item) => ctx.content.items[item.defId]?.toolKinds.includes(kind)),
  );
}

function runRecipe(ctx: StepCtx, deps: WorkDeps, actor: Actor): StepResult {
  const activity = actor.activity;
  if (activity.kind !== "task") return { fail: "dependencyPending" };
  const task = ctx.state.work.tasks[activity.taskId];
  if (task === undefined) return { fail: "dependencyPending" };
  if (!hasTools(ctx, actor, task)) return { fail: "missingTool" };
  if (task.status === "claimed") task.status = "active";
  const recipeCtx: RecipeCtx = {
    state: ctx.state,
    content: ctx.content,
    config: ctx.config,
    tick: ctx.tick,
  };
  const outcome = deps.stages.advance(recipeCtx, task.id, actor.id, workRate(ctx, actor, task));
  switch (outcome.status) {
    case "notFound":
      return isCompletionMet(ctx.state, ctx.content, task) ? "done" : { fail: "unknownDiagnosis" };
    case "inProgress":
      return "wait";
    case "stepComplete":
      for (const event of outcome.events) ctx.emit(event);
      return "wait";
    case "recipeComplete":
      for (const event of outcome.events) ctx.emit(event);
      touchInventory(ctx);
      return "done";
  }
}

function runConsume(ctx: StepCtx, actor: Actor, step: StepOf<"consume">): StepResult {
  const carried = carriedItems(ctx, actor.id);
  const item =
    carried.find((i) => i.id === step.itemId) ??
    carried.find((i) => ctx.content.items[i.defId]?.tags.includes("food"));
  if (item === undefined) return { fail: "inaccessibleSupply" };
  const nutrition = ctx.content.items[item.defId]?.nutrition ?? 1;
  actor.needs.hunger = Math.max(0, actor.needs.hunger - nutrition);
  if (item.stacking === "stack" && item.count > 1) item.count -= 1;
  else delete ctx.state.items[item.id];
  touchInventory(ctx);
  ctx.emit({
    type: "ateMeal",
    subjectIds: [actor.id, item.id],
    causeIds: [],
    source: "sim",
    payload: { nutrition },
  });
  return "done";
}

function runPutDown(ctx: StepCtx, actor: Actor, step: StepOf<"putDown">): StepResult {
  const item = ctx.state.items[step.itemId];
  if (
    item === undefined ||
    item.location.kind !== "carriedBy" ||
    item.location.actorId !== actor.id
  ) {
    return { fail: "inaccessibleSupply" };
  }
  const location = actor.location;
  if (location.kind !== "onDeck") return { fail: "unreachableTarget" };
  const activity = actor.activity;
  const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
  const completion = task?.completion;
  if (completion?.kind === "itemInStore") {
    if (!onTransferTile(ctx, actor) || !dockedAt(ctx, completion.portId))
      return { fail: "rampClosed" };
    item.location = {
      kind: "inExternalStore",
      portId: completion.portId,
      storeKey: completion.storeKey,
    };
  } else {
    const tile = tileOf(location);
    item.location = { kind: "onDeck", deckId: location.deckId, x: tile.x + 0.5, y: tile.y + 0.5 };
  }
  writeFact(
    actor,
    item.id,
    "itemLocation",
    { location: item.location },
    directSight(actor, ctx.tick),
  );
  touchInventory(ctx);
  return "done";
}

/**
 * D47 commit point: the purchase. Fails `rampClosed` if the ship is no longer docked at the
 * market's port, `unreachableTarget` off the transfer tile, and `inaccessibleSupply` (task-level,
 * so every candidate backs off) when the stock or the money ran out since the plan was made.
 */
function runBuy(ctx: StepCtx, actor: Actor, step: StepOf<"buy">): StepResult {
  if (!dockedAt(ctx, step.portId)) return { fail: "rampClosed" };
  if (!atMarketCounter(ctx, actor, step.portId)) return { fail: "unreachableTarget" };
  const handover = step.intoHands === true ? "hands" : "feet";
  const bought = buyFromMarket(ctx, actor, step.portId, step.itemDefId, step.count, handover);
  if (bought === undefined) return { fail: "inaccessibleSupply" };
  return "done";
}

/**
 * D63: the market is through the gate. Standing at the gate, step out (off ship) and spend the
 * counter time there; then come back to the gate tile. Fails `rampClosed` if the ship is no longer
 * docked at the port before stepping out, and `unreachableTarget` away from the gate.
 */
function runThroughGate(ctx: StepCtx, actor: Actor, step: StepOf<"throughGate">): StepResult {
  if (actor.location.kind === "onDeck") {
    if (!dockedAt(ctx, step.portId)) return { fail: "rampClosed" };
    const here = actorTile(actor);
    if (here === undefined || !near(here, step.gate)) return { fail: "unreachableTarget" };
    stepOutThroughGate(ctx, actor, step.portId);
  }
  step.ticksDone += 1;
  if (step.ticksDone < step.ticksNeeded) return "wait";
  stepBackThroughGate(ctx, actor, step.gate);
  return "done";
}

/** D63: the bought units are aboard; set them down here. Nothing in hand is a lost purchase. */
function runStowBought(ctx: StepCtx, actor: Actor, step: StepOf<"stowBought">): StepResult {
  if (actor.location.kind !== "onDeck") return { fail: "unreachableTarget" };
  const set = setDownBought(ctx, actor, step.itemDefId);
  return set.length === 0 ? { fail: "inaccessibleSupply" } : "done";
}

function holdDone(ctx: StepCtx, actor: Actor, step: StepOf<"hold">): boolean {
  const needs = ctx.config.needs;
  const onDuty = isOnDuty(actor.schedule, ctx.tick, ctx.config);
  switch (step.hold) {
    case "sleep": {
      const slept = ctx.tick - step.sinceTick >= configTicks(ctx.config, needs.sleepMinSeconds);
      const rested = actor.needs.fatigue <= needs.wakeBelow;
      const shiftCalls = onDuty && actor.needs.fatigue < needs.seekThreshold;
      return slept && (rested || shiftCalls);
    }
    case "rest":
      return onDuty && actor.needs.comfort <= 0;
    case "socialize":
      return onDuty && actor.needs.social <= 0;
    case "staff": {
      const activity = actor.activity;
      const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
      const resolved =
        task === undefined || ctx.state.work.problems[task.problemId]?.status !== "open";
      const stage = ctx.state.travel.stage;
      return resolved && (stage === "docked" || stage === "transit");
    }
  }
}

function runStep(ctx: StepCtx, deps: WorkDeps, actor: Actor, step: ActivityStep): StepResult {
  switch (step.kind) {
    case "moveTo":
      return runMove(ctx, actor, step);
    case "pickUp":
      return runPickUp(ctx, actor, step);
    case "work":
      if (step.stage === "recipe") return runRecipe(ctx, deps, actor);
      step.ticksDone += 1;
      return step.ticksDone >= step.ticksNeeded ? "done" : "wait";
    case "consume":
      return runConsume(ctx, actor, step);
    case "putDown":
      return runPutDown(ctx, actor, step);
    case "buy":
      return runBuy(ctx, actor, step);
    case "throughGate":
      return runThroughGate(ctx, actor, step);
    case "stowBought":
      return runStowBought(ctx, actor, step);
    case "hold":
      return holdDone(ctx, actor, step) ? "done" : "wait";
  }
}

function enterStep(ctx: StepCtx, actor: Actor): void {
  const step = currentStep(actor.activity);
  if (step?.kind !== "hold") return;
  (step as StepOf<"hold">).sinceTick = ctx.tick;
  if (step.hold === "sleep") {
    ctx.emit({
      type: "fellAsleep",
      subjectIds: [actor.id],
      causeIds: [],
      source: "sim",
      payload: {},
    });
  }
}

function completedStepEvent(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind === "idle" || activity.action.kind === "walk") return;
  ctx.emit({
    type: "actionCompleted",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    payload: { action: activity.action.kind },
  });
}

function advanceActivity(ctx: StepCtx, deps: WorkDeps, actor: Actor): void {
  for (let guard = 0; guard < MAX_STEPS_PER_TICK; guard++) {
    const activity = actor.activity;
    if (activity.kind === "idle" || activity.plan === undefined) return;
    const plan = activity.plan;
    const step = plan.steps[plan.stepIndex];
    if (step === undefined) {
      finishActivity(ctx, actor);
      return;
    }
    const result = runStep(ctx, deps, actor, step);
    if (result === "wait") return;
    if (result !== "done") {
      failActivity(ctx, actor, result.fail);
      return;
    }
    if (step.kind === "hold") leaveHold(ctx, actor);
    completedStepEvent(ctx, actor);
    plan.stepIndex += 1;
    if (plan.stepIndex >= plan.steps.length) {
      finishActivity(ctx, actor);
      return;
    }
    enterStep(ctx, actor);
    refreshPresentation(ctx, actor);
  }
}

// ---------------------------------------------------------------------------------------------
// Starting activities from intents
// ---------------------------------------------------------------------------------------------

/** Tell a new hauler where the manifest says the cargo is (unless they already know better). */
function learnManifest(ctx: StepCtx, actor: Actor, task: Task): void {
  if (task.type !== "haul" || task.target.kind !== "item") return;
  const item = ctx.state.items[task.target.itemId];
  if (item === undefined || believedLocation(actor, item.id) !== undefined) return;
  writeFact(
    actor,
    item.id,
    "itemLocation",
    { location: item.location },
    {
      tick: ctx.tick,
      sourceId: actor.id,
      evidence: "report",
      certainty: "reported",
    },
  );
}

function startTask(ctx: StepCtx, actor: Actor, intent: Extract<Intent, { kind: "task" }>): void {
  const task = ctx.state.work.tasks[intent.taskId];
  if (task === undefined || isTerminal(task)) return;
  const current = actor.activity;
  if (current.kind === "task" && current.taskId === task.id) return;
  const others = claimantsOf(ctx, task.id).filter((id) => id !== actor.id);
  if (others.length >= task.workerSlots) return;
  if (task.blockage !== undefined && ctx.tick < task.blockage.retryAfterTick) return;
  learnManifest(ctx, actor, task);
  // Plan against truth before dropping what the actor is doing: the planner chose from beliefs,
  // and a choice that cannot be carried out (a repair whose parts are not aboard) must not make
  // them set a crate down mid-haul. Aborting only moves things from hand to feet, so a plan
  // that fails now would fail after the abort too; the plan used is rebuilt after it.
  const feasible = buildTaskPlan(ctx, actor, task);
  if (!feasible.ok) {
    setBackoff(ctx, actor, backoffRef.task(task.id));
    blockTask(ctx, actor, task, feasible.reason);
    return;
  }
  abortActivity(ctx, actor, "interrupted");
  const plan = buildTaskPlan(ctx, actor, task);
  if (!plan.ok) {
    setBackoff(ctx, actor, backoffRef.task(task.id));
    blockTask(ctx, actor, task, plan.reason);
    return;
  }
  const claimId = claimTask(ctx, actor, task);
  const first = plan.plan.steps[0] as ActivityStep;
  const activity: Activity = {
    kind: "task",
    taskId: task.id,
    claimId,
    urgency: intent.urgency,
    action: makeAction("wait", "waiting", ctx.tick),
    sinceTick: ctx.tick,
    plan: plan.plan,
  };
  activity.action = actionFor(ctx, activity, first);
  actor.activity = activity;
  ctx.emit({
    type: "taskSelected",
    subjectIds: [actor.id, task.id],
    causeIds: [],
    source: "sim",
    payload: { taskId: task.id, urgency: intent.urgency },
  });
}

function samePersonal(activity: Activity, intent: Extract<Intent, { kind: "personal" }>): boolean {
  return activity.kind === "personal" && activity.activity === intent.activity;
}

function startPersonal(
  ctx: StepCtx,
  actor: Actor,
  intent: Extract<Intent, { kind: "personal" }>,
): void {
  if (samePersonal(actor.activity, intent)) return;
  const ref = backoffRef.personal(
    intent.activity,
    intent.itemId ?? (intent.targetId as MachineId | undefined),
  );
  // As for tasks: an activity that cannot be carried out leaves the current one alone.
  if (!buildPersonalPlan(ctx, actor, intent).ok) {
    setBackoff(ctx, actor, ref);
    return;
  }
  abortActivity(ctx, actor, "interrupted");
  const plan = buildPersonalPlan(ctx, actor, intent);
  if (!plan.ok) {
    setBackoff(ctx, actor, ref);
    return;
  }
  const first = plan.plan.steps[0] as ActivityStep;
  const activity: Activity = {
    kind: "personal",
    activity: intent.activity,
    urgency: intent.urgency,
    action: makeAction("wait", "waiting", ctx.tick),
    sinceTick: ctx.tick,
    plan: plan.plan,
  };
  activity.action = actionFor(ctx, activity, first);
  actor.activity = activity;
  enterStep(ctx, actor);
  ctx.emit({
    type: "personalActivityStarted",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    payload: { activity: intent.activity, urgency: intent.urgency },
  });
}

function applyIntent(ctx: StepCtx, actor: Actor): void {
  const intent = actor.pendingIntent;
  if (intent === undefined) return;
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete actor.pendingIntent;
  switch (intent.kind) {
    case "continue":
      return;
    case "idle":
      abortActivity(ctx, actor, "interrupted");
      return;
    case "task":
      startTask(ctx, actor, intent);
      return;
    case "personal":
      startPersonal(ctx, actor, intent);
      return;
  }
}

/** Drop a task activity whose task was completed, cancelled or lost its claim elsewhere. */
function validateTaskActivity(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind !== "task") return;
  const task = ctx.state.work.tasks[activity.taskId];
  if (task === undefined || task.status === "cancelled") {
    abortActivity(ctx, actor, "cancelled");
  } else if (task.status === "completed") {
    abortActivity(ctx, actor, "cancelled");
  } else if (ctx.state.work.claims[activity.claimId] === undefined) {
    abortActivity(ctx, actor, "failed");
  }
}

/** One crew actor's tick of work. */
export function stepActor(ctx: StepCtx, deps: WorkDeps, actor: Actor): void {
  pruneBackoff(ctx, actor);
  // D63: a buyer out through the gate is off ship but still on the errand, which brings them back.
  if (actor.availability !== "available" && !isOutThroughGate(actor)) {
    abortActivity(ctx, actor, "incapacitated");
    if (actor.pendingIntent !== undefined) {
      // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
      delete actor.pendingIntent;
    }
    return;
  }
  applyIntent(ctx, actor);
  validateTaskActivity(ctx, actor);
  advanceActivity(ctx, deps, actor);
  const activity = actor.activity;
  if (activity.kind === "task") renewClaim(ctx, activity.claimId);
  refreshPresentation(ctx, actor);
}

/** Release claims whose owner stopped renewing them (SD §14.5). */
export function expireClaims(ctx: StepCtx): void {
  for (const claim of Object.values(ctx.state.work.claims)) {
    if (ctx.tick <= claim.expiresAtTick) continue;
    const task = ctx.state.work.tasks[claim.taskId];
    const owner = ctx.state.actors[claim.ownerActorId];
    ctx.emit({
      type: "claimExpired",
      subjectIds: [claim.ownerActorId, claim.taskId],
      causeIds: [],
      source: "sim",
      payload: { taskId: claim.taskId },
    });
    if (
      owner !== undefined &&
      owner.activity.kind === "task" &&
      owner.activity.claimId === claim.id
    ) {
      abortActivity(ctx, owner, "failed");
    }
    if (task !== undefined) releaseActorClaim(ctx, claim.ownerActorId, task, "failed");
    delete ctx.state.work.claims[claim.id];
  }
}
