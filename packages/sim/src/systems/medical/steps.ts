/**
 * Steps of medicine (§treatment-at-the-medbay-bed, §convalescing):
 *
 * - `runTreat`: beside the bed with `medical.kitsPerTreatment` units in hand and the patient lying
 *   at it, `treat` work counts `workRate` a tick; at the end the units are used up, every wound
 *   that wanted treating is marked treated (`Wound.treatedTick`) and stops bleeding, the patient's
 *   pain drops by `bodies.treatPainRelief`, `woundTreated` names who treated whom, and the wounded
 *   problem resolves. Without the units it fails `inaccessibleSupply`; away from the bed,
 *   `unreachableTarget`; with the patient not on the bed it waits while they walk to it
 *   (`convalesce`) and fails `dependencyPending` otherwise.
 * - `convalesceHoldDone`: the patient's hold at the bed ends once nothing is left to treat, or
 *   after `medical.giveUpAfterSeconds` with too few `medical` units aboard to treat them; giving up
 *   backs the `convalesce` candidate off for as long again, so they do not walk straight back.
 */
import { applyCapacities } from "../../core/body";
import { configTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep, Task } from "../../core/types/work";
import { chebyshev } from "../damage/deck";
import { useUp } from "../damage/steps";
import { unitsAboard } from "../equipment/supplies";
import { backoffRef } from "../work/activity";
import { emitSim } from "../work/events";
import { tileOf } from "../work/plans";
import { type StepResult, workRate } from "../work/steps";
import { convalescing, medBedOf, onTheBed } from "./bed";
import { untreatedWounds } from "./medical";
import { kitsInHand, unitsOf } from "./plans";

type WorkStep = Extract<ActivityStep, { kind: "work" }>;
type HoldStep = Extract<ActivityStep, { kind: "hold" }>;

function taskOf(ctx: StepCtx, actor: Actor): Task | undefined {
  const activity = actor.activity;
  return activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
}

/** Use up `count` units from the carried `medical` items. */
function useUpKits(ctx: StepCtx, actor: Actor, count: number): void {
  for (let left = count; left > 0; left--) {
    const [item] = kitsInHand(ctx, actor);
    if (item === undefined) throw new Error(`medical: ${actor.id} ran out of kits mid-treatment`);
    useUp(ctx, item);
  }
}

export function runTreat(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const task = taskOf(ctx, actor);
  if (task?.type !== "treatWounds" || task.target.kind !== "actor") {
    return { fail: "dependencyPending" };
  }
  const problem = ctx.state.work.problems[task.problemId];
  // Treated already (or the problem settled): the plan's end completes the task.
  if (problem?.status !== "open") return "done";
  const patient = ctx.state.actors[task.target.actorId];
  const bed = medBedOf(ctx.state, ctx.content);
  if (patient === undefined || bed === undefined) return { fail: "unreachableTarget" };
  const need = ctx.config.medical.kitsPerTreatment;
  if (unitsOf(kitsInHand(ctx, actor)) < need) return { fail: "inaccessibleSupply" };
  if (actor.location.kind !== "onDeck" || chebyshev(tileOf(actor.location), bed.useTile) > 1) {
    return { fail: "unreachableTarget" };
  }
  if (!onTheBed(ctx.state, bed, patient)) {
    // The medic got ready while the patient came: wait at the bedside while they are on their way.
    return convalescing(patient) ? "wait" : { fail: "dependencyPending" };
  }
  if (task.status === "claimed") task.status = "active";
  step.ticksDone += workRate(ctx, actor, task);
  if (step.ticksDone < step.ticksNeeded) return "wait";
  useUpKits(ctx, actor, need);
  const wounds = untreatedWounds(patient);
  for (const wound of wounds) {
    wound.treatedTick = ctx.tick;
    wound.bleeding = false;
  }
  patient.body.pain = Math.max(0, patient.body.pain - ctx.config.bodies.treatPainRelief);
  // Pain is in consciousness; as at a hit, capacities follow at once (a patient who is down is
  // stepped by no needs system until the bodies system's next step).
  applyCapacities(patient, ctx.config);
  emitSim(ctx, "woundTreated", [patient.id, actor.id], {
    actorId: patient.id,
    byActorId: actor.id,
    woundIds: wounds.map((w) => w.id),
    parts: wounds.map((w) => w.part),
  });
  problem.status = "resolved";
  emitSim(ctx, "problemResolved", [problem.id], { problemId: problem.id, kind: problem.kind });
  return "done";
}

/** Too few `medical` units aboard for one treatment. */
function noKitAboard(ctx: StepCtx): boolean {
  let units = 0;
  for (const [defId, count] of unitsAboard(ctx.state)) {
    if (ctx.content.items[defId]?.tags.includes("medical") === true) units += count;
  }
  return units < ctx.config.medical.kitsPerTreatment;
}

export function convalesceHoldDone(ctx: StepCtx, actor: Actor, step: HoldStep): boolean {
  if (untreatedWounds(actor).length === 0) return true;
  const giveUp = configTicks(ctx.config, ctx.config.medical.giveUpAfterSeconds);
  if (ctx.tick - step.sinceTick < giveUp || !noKitAboard(ctx)) return false;
  actor.workBackoff = {
    ...(actor.workBackoff ?? {}),
    [backoffRef.personal("convalesce")]: ctx.tick + giveUp,
  };
  return true;
}
