/**
 * Plans for damage work (D93, D94): `repairDamage` (the welder to a `repair` position),
 * `patchHull` (the welder and a patch kit to beside the scar), `plateHull` (the welder and a
 * plate), `checkCompartment` (a scout's walk in), and the officer of the watch's `holdBridge`.
 *
 * Gate stubs: blocked.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { Task } from "../../core/types/work";
import { type PlanResult, blocked } from "../work/plans";

export function repairDamagePlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return blocked("unreachableTarget");
}

export function patchPlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return blocked("unreachableTarget");
}

export function platePlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return blocked("unreachableTarget");
}

export function checkPlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return blocked("unreachableTarget");
}

export function holdBridgePlan(_ctx: StepCtx, _actor: Actor): PlanResult {
  return blocked("unreachableTarget");
}
