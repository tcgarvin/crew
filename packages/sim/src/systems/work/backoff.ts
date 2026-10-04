/**
 * Retry backoff (see `Actor.workBackoff`): a failed activity or task is not retried every tick.
 */
import { configTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { Activity } from "../../core/types/work";
import { backoffRef } from "./activity";

export function backoffTicks(ctx: StepCtx): number {
  return configTicks(ctx.config, ctx.config.work.retryBackoffSeconds);
}

export function setBackoff(ctx: StepCtx, actor: Actor, ref: string): void {
  actor.workBackoff = { ...(actor.workBackoff ?? {}), [ref]: ctx.tick + backoffTicks(ctx) };
}

export function pruneBackoff(ctx: StepCtx, actor: Actor): void {
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

/** Backoff ref for the actor's current activity. */
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
