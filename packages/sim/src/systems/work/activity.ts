/**
 * Small pure helpers over `Activity` shared by work, needs and ambient chat.
 */
import type { DeepReadonly, Tick } from "../../core/types/common";
import type { Activity, ActivityStep, HoldKind } from "../../core/types/work";

/** The step the activity is on, if it has a plan and is not past its end. */
export function currentStep(
  activity: DeepReadonly<Activity>,
): DeepReadonly<ActivityStep> | undefined {
  if (activity.kind === "idle" || activity.plan === undefined) return undefined;
  return activity.plan.steps[activity.plan.stepIndex];
}

/** The hold the actor is in (asleep, at the helm, resting, socializing), if any. */
export function currentHold(activity: DeepReadonly<Activity>): HoldKind | undefined {
  const step = currentStep(activity);
  return step?.kind === "hold" ? step.hold : undefined;
}

export function isAsleep(activity: DeepReadonly<Activity>): boolean {
  return currentHold(activity) === "sleep";
}

/** Backoff refs (see `Actor.workBackoff`). */
export const backoffRef = {
  task: (taskId: string): string => `task:${taskId}`,
  personal: (activity: string, targetId?: string): string =>
    targetId === undefined ? activity : `${activity}:${targetId}`,
};

/** Is `ref` still backing off at `tick`? */
export function isBackingOff(
  backoff: Readonly<Record<string, Tick>> | undefined,
  ref: string,
  tick: Tick,
): boolean {
  const until = backoff?.[ref];
  return until !== undefined && tick < until;
}
