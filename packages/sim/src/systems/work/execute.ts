/**
 * Action execution (SD §14.3–14.7), phase 3 after spatial movement, every tick.
 *
 * Each crew actor's `pendingIntent` (written by the planner last tick) is turned into a claim and
 * a bounded plan (`plans.ts`); the plan's current step is then advanced against truth
 * (`steps.ts`). A step either finishes (the next one starts the same tick), waits, or fails with
 * a structured `BlockageReason`. A failure records a retry backoff on the actor (and, for
 * task-level causes, on the task) so nothing is retried every tick, releases the claim, drops
 * hauled cargo where the actor stands, and leaves the actor idle for the planner to pick
 * something else.
 *
 * D65: a haul may start as a hand-truck trip (`truck.ts`), one activity holding the claims of
 * several hauls (`Activity.haul.legs`); renewal, expiry, validation and every way of stopping
 * cover all of them, and a stopped trip sets the truck and its load down where the pusher is.
 */
import type { Actor } from "../../core/types/actor";
import type { TaskReleaseReason } from "../../core/types/events";
import type { MachineId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type {
  Activity,
  ActivityStep,
  BlockageReason,
  HaulLeg,
  Intent,
  Task,
} from "../../core/types/work";
import { onWoke } from "../cabins/cabins";
import { leaveTalk } from "../cabins/private-talk";
import { setDownBought } from "../commerce/market";
import { leaveRecreation } from "../recreation/sessions";
import { stopMovement } from "../spatial/movement";
import { releaseReservations } from "../spatial/reservations";
import { actionFor, refreshPresentation } from "./actions";
import { backoffRef, currentHold, currentStep, isOutThroughGate } from "./activity";
import { activityRef, backoffTicks, pruneBackoff, setBackoff } from "./backoff";
import { claimTask, completeTask, isCompletionMet, releaseActorClaim, renewClaim } from "./claims";
import { claimantsOf, isTerminal } from "./derivation";
import { emitSim } from "./events";
import { seeItem, writeFact } from "./facts";
import { awaitsFamiliarityBrief } from "./perception";
import {
  type PlanResult,
  believedLocation,
  buildPersonalPlan,
  buildTaskPlan,
  carriedItems,
  isCarriedBy,
} from "./plans";
import { meetingAhead } from "./shore";
import { type WorkDeps, endGateErrand, runStep, touchInventory } from "./steps";
import { buildTruckPlan, dropTruckLoad, heldTasks, settleHeld } from "./truck";

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
// Ending activities
// ---------------------------------------------------------------------------------------------

/** Put hauled cargo down exactly where the actor is (SD §14.6: no teleporting). */
function dropHaulCargo(ctx: StepCtx, actor: Actor, task: Task): void {
  if (actor.location.kind !== "onDeck") return;
  // D63: a buyer stopped while carrying bought units aboard sets them down where they stand
  // (possibly on the dock, where they still count as within reach while docked).
  if (task.type === "buyParts" && task.progressRef.kind === "market") {
    setDownBought(ctx, actor, task.progressRef.itemDefId);
  }
  if (task.type !== "haul" || task.target.kind !== "item") return;
  const item = ctx.state.items[task.target.itemId];
  if (item === undefined || !isCarriedBy(ctx, item.id, actor.id)) return;
  const { deckId, x, y } = actor.location;
  item.location = { kind: "onDeck", deckId, x, y };
  seeItem(actor, item.id, item.location, ctx.tick);
  touchInventory(ctx);
}

/**
 * Set down the tools and consumables the actor picked up for a task they are giving up or have
 * finished (D64, D69), where they stand: carried on, the ship's only spares (or wrench) would be
 * out of everyone else's reach until this actor happened to take the task up again. D69: they
 * say where they left them, so the rest of the crew, whose last belief was "in their hands" or
 * "not where it was", can fetch them for the next repair.
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
    seeItem(actor, item.id, item.location, ctx.tick);
    tellCrew(ctx, actor, item);
    dropped = true;
  }
  if (dropped) touchInventory(ctx);
}

/** D69: the rest of the crew hear where `item` was left (a report, like D63's freight brief). */
function tellCrew(ctx: StepCtx, teller: Actor, item: Item): void {
  const source = {
    tick: ctx.tick,
    sourceId: teller.id,
    evidence: "report",
    certainty: "reported",
  } as const;
  for (const other of Object.values(ctx.state.actors)) {
    if (other.id === teller.id || !other.crew || other.passenger === true) continue;
    // Their first look's familiarity brief covers it; a fact written first would stop that brief.
    if (awaitsFamiliarityBrief(other)) continue;
    writeFact(other, item.id, "itemLocation", { location: item.location }, source);
  }
}

/**
 * Leaving the hold the actor is on. `completed`: the hold ended on its own condition (a sleep
 * slept out), not because the activity was taken off them; only then do the cabins' waking
 * thoughts come (slice 4, `onWoke`, with the hold still the current step).
 */
function leaveHold(ctx: StepCtx, actor: Actor, completed: boolean): void {
  if (currentHold(actor.activity) !== "sleep") return;
  if (completed) onWoke(ctx, actor);
  emitSim(ctx, "wokeUp", [actor.id], {});
}

/** Stop whatever the actor is doing, releasing its claim. Safe to call when idle. */
export function abortActivity(ctx: StepCtx, actor: Actor, reason: TaskReleaseReason): void {
  const activity = actor.activity;
  if (activity.kind === "idle") return;
  // D63: nobody is left out through the gate by an errand that stopped.
  endGateErrand(ctx, actor);
  if (actor.movement.kind === "moving") stopMovement(ctx.state, ctx.caches, actor.id);
  else releaseReservations(ctx.caches, actor.id);
  leaveHold(ctx, actor, false);
  // Slice 4: out of any session (setting down a book or instrument) and off any talk, while the
  // activity is still theirs to read.
  leaveRecreation(ctx, actor);
  leaveTalk(ctx, actor);
  if (activity.kind === "task" && activity.haul !== undefined) {
    // D65: the truck and its load go down here; each held task is settled on where its crate is.
    if (dropTruckLoad(ctx, actor, activity.haul.truckId)) touchInventory(ctx);
    for (const held of heldTasks(activity)) settleHeld(ctx, actor, held.taskId, reason);
  } else if (activity.kind === "task") {
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
  emitSim(ctx, "actionFailed", [actor.id], { action: activity.action.kind, reason });
  setBackoff(ctx, actor, activityRef(activity));
  if (activity.kind === "task") {
    const task = ctx.state.work.tasks[activity.taskId];
    if (task !== undefined) blockTask(ctx, actor, task, reason);
  }
  abortActivity(ctx, actor, "failed");
}

function blockTask(ctx: StepCtx, actor: Actor, task: Task, reason: BlockageReason): void {
  emitSim(ctx, "taskBlocked", [actor.id, task.id], { taskId: task.id, reason });
  if (TASK_LEVEL.has(reason)) {
    task.blockage = { reason, sinceTick: ctx.tick, retryAfterTick: ctx.tick + backoffTicks(ctx) };
  }
}

/** The plan ran out of steps. */
function finishActivity(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind === "task") {
    // D65: every leg settled as its crate came off the truck; anything left is settled now.
    for (const leg of activity.haul?.legs ?? []) settleHeld(ctx, actor, leg.taskId, "failed");
    const task = ctx.state.work.tasks[activity.taskId];
    if (task !== undefined && !isTerminal(task)) {
      if (isCompletionMet(ctx.state, ctx.content, task)) completeTask(ctx, task);
      else releaseActorClaim(ctx, actor.id, task, "failed");
      // D69: done or not, what is left of its tools and parts goes down here, as when it is
      // given up (D64); kept in hand, the ship's only spares went to meals and bed with them.
      dropTaskSupplies(ctx, actor, task);
    }
  }
  actor.activity = { kind: "idle" };
}

// ---------------------------------------------------------------------------------------------
// Advancing the plan
// ---------------------------------------------------------------------------------------------

/**
 * D65: the truck was not where the actor thought. The trip becomes a hand haul of the lead's
 * crate and the legs are let go. Returns false when even that cannot be planned.
 */
function singleHaulFallback(ctx: StepCtx, actor: Actor): boolean {
  const activity = actor.activity;
  if (activity.kind !== "task" || activity.haul === undefined) return false;
  for (const leg of activity.haul.legs) settleHeld(ctx, actor, leg.taskId, "failed");
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete activity.haul;
  const task = ctx.state.work.tasks[activity.taskId];
  const plan = task === undefined ? undefined : buildTaskPlan(ctx, actor, task);
  if (plan === undefined || !plan.ok) return false;
  activity.plan = plan.plan;
  return true;
}

function enterStep(ctx: StepCtx, actor: Actor): void {
  const step = currentStep(actor.activity);
  if (step?.kind !== "hold") return;
  (step as { sinceTick: number }).sinceTick = ctx.tick;
  if (step.hold === "sleep") emitSim(ctx, "fellAsleep", [actor.id], {});
}

function completedStepEvent(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind === "idle" || activity.action.kind === "walk") return;
  emitSim(ctx, "actionCompleted", [actor.id], { action: activity.action.kind });
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
      const truckMissing =
        step.kind === "pickUp" &&
        activity.kind === "task" &&
        activity.haul?.truckId === step.itemId;
      if (truckMissing && singleHaulFallback(ctx, actor)) {
        refreshPresentation(ctx, actor);
        continue;
      }
      failActivity(ctx, actor, result.fail);
      return;
    }
    if (step.kind === "hold") leaveHold(ctx, actor, true);
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
    { tick: ctx.tick, sourceId: actor.id, evidence: "report", certainty: "reported" },
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
  const refuse = (reason: BlockageReason): void => {
    setBackoff(ctx, actor, backoffRef.task(task.id));
    blockTask(ctx, actor, task, reason);
  };
  // Plan against truth before dropping what the actor is doing: the planner chose from beliefs,
  // and a choice that cannot be carried out (a repair whose parts are not aboard) must not make
  // them set a crate down mid-haul. Aborting only moves things from hand to feet, so a plan
  // that fails now would fail after the abort too; the plan used is rebuilt after it.
  const feasible = buildTaskPlan(ctx, actor, task);
  if (!feasible.ok) {
    refuse(feasible.reason);
    return;
  }
  abortActivity(ctx, actor, "interrupted");
  // D65: a haul goes on the hand truck when the actor knows of a free one and of more to move.
  const truck = buildTruckPlan(ctx, actor, task);
  const plan: PlanResult =
    truck === undefined ? buildTaskPlan(ctx, actor, task) : { ok: true, plan: truck.plan };
  if (!plan.ok) {
    refuse(plan.reason);
    return;
  }
  const claimId = claimTask(ctx, actor, task);
  actor.activity = {
    kind: "task",
    taskId: task.id,
    claimId,
    urgency: intent.urgency,
    action: actionFor(ctx, task, plan.plan.steps[0] as ActivityStep),
    sinceTick: ctx.tick,
    plan: plan.plan,
    ...(truck === undefined
      ? {}
      : {
          haul: {
            truckId: truck.truckId,
            legs: truck.legs.map((leg) => ({
              taskId: leg.id,
              claimId: claimTask(ctx, actor, leg),
            })),
          },
        }),
  };
  emitSim(ctx, "taskSelected", [actor.id, task.id], { taskId: task.id, urgency: intent.urgency });
}

function samePersonal(activity: Activity, intent: Extract<Intent, { kind: "personal" }>): boolean {
  if (activity.kind !== "personal" || activity.activity !== intent.activity) return false;
  // D70: a meeting for another card (this one's delivered, they are walking back) is not the same.
  return intent.activity !== "meetSpeaker" || meetingAhead({ activity }) === intent.decisionId;
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
  actor.activity = {
    kind: "personal",
    activity: intent.activity,
    urgency: intent.urgency,
    action: actionFor(ctx, undefined, plan.plan.steps[0] as ActivityStep),
    sinceTick: ctx.tick,
    plan: plan.plan,
  };
  enterStep(ctx, actor);
  emitSim(ctx, "personalActivityStarted", [actor.id], {
    activity: intent.activity,
    urgency: intent.urgency,
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

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

function legLive(ctx: StepCtx, leg: HaulLeg): boolean {
  const task = ctx.state.work.tasks[leg.taskId];
  return (
    task !== undefined && !isTerminal(task) && ctx.state.work.claims[leg.claimId] !== undefined
  );
}

/** Drop a task activity whose task was completed, cancelled or lost its claim elsewhere. */
function validateTaskActivity(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind !== "task") return;
  const task = ctx.state.work.tasks[activity.taskId];
  if (task === undefined || task.status === "cancelled" || task.status === "completed") {
    abortActivity(ctx, actor, "cancelled");
  } else if (ctx.state.work.claims[activity.claimId] === undefined) {
    abortActivity(ctx, actor, "failed");
  } else if (activity.haul?.legs.some((leg) => !legLive(ctx, leg))) {
    // D65: a leg's task went away under the trip; set it all down and plan afresh.
    abortActivity(ctx, actor, "cancelled");
  }
}

/** One crew actor's tick of work. */
export function stepActor(ctx: StepCtx, deps: WorkDeps, actor: Actor): void {
  pruneBackoff(ctx, actor);
  // D63: a buyer out through the gate is off ship but still on the errand, which brings them back.
  if (actor.availability !== "available" && !isOutThroughGate(actor)) {
    abortActivity(ctx, actor, "incapacitated");
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete actor.pendingIntent;
    return;
  }
  applyIntent(ctx, actor);
  validateTaskActivity(ctx, actor);
  advanceActivity(ctx, deps, actor);
  const activity = actor.activity;
  if (activity.kind === "task") {
    for (const held of heldTasks(activity)) renewClaim(ctx, held.claimId);
  }
  refreshPresentation(ctx, actor);
}

/** Release claims whose owner stopped renewing them (SD §14.5). */
export function expireClaims(ctx: StepCtx): void {
  for (const claim of Object.values(ctx.state.work.claims)) {
    if (ctx.tick <= claim.expiresAtTick) continue;
    const task = ctx.state.work.tasks[claim.taskId];
    const owner = ctx.state.actors[claim.ownerActorId];
    emitSim(ctx, "claimExpired", [claim.ownerActorId, claim.taskId], { taskId: claim.taskId });
    const activity = owner?.activity;
    if (
      owner !== undefined &&
      activity?.kind === "task" &&
      heldTasks(activity).some((held) => held.claimId === claim.id)
    ) {
      abortActivity(ctx, owner, "failed");
    }
    if (task !== undefined) releaseActorClaim(ctx, claim.ownerActorId, task, "failed");
    delete ctx.state.work.claims[claim.id];
  }
}
