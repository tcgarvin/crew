/**
 * Steps of damage work (§machine-damage, §scouts):
 *
 * - `runMend`: at the machine with a welder in hand, integrity rises by
 *   `workRate / repairSecondsPerIntegrity` a second; at whole it is set to 1, `machineDamaged`
 *   resolves and `machineMended` names the mender.
 * - `runPatch`: beside the scar with a welder and a kit, `patchSeconds` of work (`workRate`); at
 *   the end one kit is used up, the scar gets back `field.patchRecovers` of its damage and is
 *   marked patched, the hull bar rises by that (`integrityFromScars`), `hullPatched`; the scar's
 *   problem is revised so its patch is no longer derived.
 * - `runPlate`: the same with a plate and `plateSeconds`; at the end the plate is used up, the
 *   scar is removed and the hull bar rises by what it still cost in the same step, the problem
 *   resolves, `hullPlated`.
 * - `runCheck`: `checkSeconds` standing in the room, then the scout looks round (`observe`: what
 *   they see is perception's) and the check resolves.
 * - `bridgeHoldDone`: the officer of the watch's hold ends when the alert clears or the watch has
 *   passed to someone else.
 *
 * Every hull write goes through `core/hull.ts`, so the bar is always `max` less the scars' damage
 * left (the invariant the field's charges share).
 *
 * Owner: W2 of ship life slice 5.
 */
import { integrityFromScars } from "../../core/hull";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { HullScar } from "../../core/types/state";
import type { ActivityStep, Problem, Task } from "../../core/types/work";
import { isOfficerOfTheWatch } from "../watch/helm";
import { emitSim } from "../work/events";
import { observe } from "../work/perception";
import { tileOf } from "../work/plans";
import { type StepResult, touchInventory, workRate } from "../work/steps";
import { besides, taggedInHand, welderInHand } from "./plans";
import { resolve } from "./problems";

type WorkStep = Extract<ActivityStep, { kind: "work" }>;
type HoldStep = Extract<ActivityStep, { kind: "hold" }>;

/** The actor's current task, if they are on one. */
function taskOf(ctx: StepCtx, actor: Actor): Task | undefined {
  const activity = actor.activity;
  return activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
}

function openProblemOf(ctx: StepCtx, task: Task): Problem | undefined {
  const problem = ctx.state.work.problems[task.problemId];
  return problem?.status === "open" ? problem : undefined;
}

/** Use up one unit of a carried stack (or the whole item). */
export function useUp(ctx: StepCtx, item: Item): void {
  if (item.stacking === "stack" && item.count > 1) item.count -= 1;
  else delete ctx.state.items[item.id];
  touchInventory(ctx);
}

function setHullFromScars(ctx: StepCtx): void {
  ctx.state.hull.integrity = integrityFromScars(ctx.state.hull);
}

export function runMend(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const task = taskOf(ctx, actor);
  if (task?.type !== "repairDamage" || task.target.kind !== "machine") {
    return { fail: "dependencyPending" };
  }
  const problem = openProblemOf(ctx, task);
  // Whole already (resolved by the damage pass): the plan's end completes the task.
  if (problem === undefined) return "done";
  const machine = ctx.state.machines[task.target.machineId];
  if (machine === undefined) return { fail: "unreachableTarget" };
  if (welderInHand(ctx, actor) === undefined) return { fail: "missingTool" };
  if (task.status === "claimed") task.status = "active";
  const secondsPerUnit = ctx.config.damage.repairSecondsPerIntegrity;
  const gain =
    secondsPerUnit > 0
      ? workRate(ctx, actor, task) / (secondsPerUnit * ctx.config.time.tickRate)
      : Number.POSITIVE_INFINITY;
  machine.integrity = Math.min(1, machine.integrity + gain);
  ctx.dirty.power = true;
  step.ticksDone += 1;
  if (machine.integrity < 1) return "wait";
  resolve(ctx, problem);
  emitSim(ctx, "machineMended", [actor.id, machine.id], {
    actorId: actor.id,
    machineId: machine.id,
  });
  return "done";
}

/** The scar a hull task is for, while it is on the hull. */
function scarOf(ctx: StepCtx, task: Task): HullScar | undefined {
  if (task.target.kind !== "scar") return undefined;
  const scarId = task.target.scarId;
  return ctx.state.hull.scars.find((s) => s.id === scarId);
}

/**
 * The timed part of a patch or plate, shared: the scar still there, the welder and the unit in
 * hand, standing beside it. Returns the unit once the work is done, `"wait"` before, or a failure.
 */
function weld(
  ctx: StepCtx,
  actor: Actor,
  step: WorkStep,
  task: Task,
  scar: HullScar,
  tag: "patchKit" | "plating",
): Item | StepResult {
  if (welderInHand(ctx, actor) === undefined) return { fail: "missingTool" };
  const unit = taggedInHand(ctx, actor, tag);
  if (unit === undefined) return { fail: "inaccessibleSupply" };
  if (actor.location.kind !== "onDeck" || !besides(tileOf(actor.location), scar.tile)) {
    return { fail: "unreachableTarget" };
  }
  if (task.status === "claimed") task.status = "active";
  step.ticksDone += workRate(ctx, actor, task);
  return step.ticksDone < step.ticksNeeded ? "wait" : unit;
}

const isItem = (result: Item | StepResult): result is Item =>
  typeof result === "object" && "id" in result;

export function runPatch(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const task = taskOf(ctx, actor);
  if (task?.type !== "patchHull") return { fail: "dependencyPending" };
  const scar = scarOf(ctx, task);
  if (scar === undefined) return { fail: "dependencyPending" };
  // Someone else's patch got there first: nothing left to weld, the plan's end completes it.
  if (scar.patched) return "done";
  const result = weld(ctx, actor, step, task, scar, "patchKit");
  if (!isItem(result)) return result;
  useUp(ctx, result);
  const recovered = Math.min(scar.damage, scar.damage * ctx.config.field.patchRecovers);
  scar.recovered = recovered;
  scar.patched = true;
  setHullFromScars(ctx);
  const problem = openProblemOf(ctx, task);
  if (problem !== undefined) problem.revision += 1;
  emitSim(ctx, "hullPatched", [actor.id, scar.id, scar.compartmentId], {
    actorId: actor.id,
    scarId: scar.id,
    compartmentId: scar.compartmentId,
    recovered,
  });
  return "done";
}

export function runPlate(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const task = taskOf(ctx, actor);
  if (task?.type !== "plateHull") return { fail: "dependencyPending" };
  const scar = scarOf(ctx, task);
  if (scar === undefined) return { fail: "dependencyPending" };
  const result = weld(ctx, actor, step, task, scar, "plating");
  if (!isItem(result)) return result;
  useUp(ctx, result);
  const recovered = scar.damage - scar.recovered;
  ctx.state.hull.scars = ctx.state.hull.scars.filter((s) => s.id !== scar.id);
  setHullFromScars(ctx);
  const problem = openProblemOf(ctx, task);
  if (problem !== undefined) resolve(ctx, problem);
  emitSim(ctx, "hullPlated", [actor.id, scar.id, scar.compartmentId], {
    actorId: actor.id,
    scarId: scar.id,
    compartmentId: scar.compartmentId,
    recovered,
  });
  return "done";
}

export function runCheck(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const task = taskOf(ctx, actor);
  if (task?.type !== "checkCompartment" || task.target.kind !== "compartment") {
    return { fail: "dependencyPending" };
  }
  if (task.status === "claimed") task.status = "active";
  step.ticksDone += 1;
  if (step.ticksDone < step.ticksNeeded) return "wait";
  observe(ctx, actor);
  const problem = openProblemOf(ctx, task);
  if (problem !== undefined) resolve(ctx, problem);
  return "done";
}

/**
 * The officer of the watch's bridge hold ends when the alert has cleared, or when the watch has
 * passed and they are no longer its officer (the next one takes the bridge).
 */
export function bridgeHoldDone(ctx: StepCtx, actor: Actor, _step: HoldStep): boolean {
  return ctx.state.alert === undefined || !isOfficerOfTheWatch(ctx, actor.id);
}
