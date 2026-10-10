/**
 * `Activity.action` and `Activity.label`: the render/inspector mirror of the step an activity is
 * on. Derived from the plan; nothing in the sim reads them back.
 */
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { Action, ActionKind, ActionStages, ActivityStep, Task } from "../../core/types/work";
import { emitSim } from "./events";
import { labelFor } from "./labels";

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

/** The action for `step` of an activity on `task` (undefined for a personal activity). */
export function actionFor(ctx: StepCtx, task: Task | undefined, step: ActivityStep): Action {
  const tick = ctx.tick;
  const machineId = task?.target.kind === "machine" ? task.target.machineId : undefined;
  switch (step.kind) {
    case "moveTo":
      return makeAction("walk", "moving", tick);
    case "pickUp":
    case "loadTruck":
      return makeAction("pickUp", "reaching", tick, step.itemId);
    case "putDown":
    case "unloadTruck":
      return makeAction("putDown", "placing", tick, step.itemId);
    case "consume":
      return makeAction("eat", "eating", tick, step.itemId);
    case "buy":
      return makeAction("pickUp", "reaching", tick);
    case "stowBought":
    case "serve":
      return makeAction("putDown", "placing", tick);
    case "parkTruck":
      return makeAction("putDown", "placing", tick, step.truckId);
    case "throughGate":
    case "awaitWord":
    case "deliverCard":
      return makeAction("wait", "waiting", tick);
    case "talk":
      return makeAction("chat", "talking", tick);
    case "work": {
      if (step.stage === "eat") return makeAction("eat", "eating", tick);
      if (step.stage === "buy") return makeAction("wait", "waiting", tick);
      // §reporting-damage: a report on the intercom; a scout's look round.
      if (step.stage === "report") return makeAction("report", "talking", tick);
      if (step.stage === "check") return makeAction("inspect", "working", tick);
      const kind = RECIPE_ACTION[task?.derivationKey ?? ""] ?? "repair";
      return makeAction(kind, "working", tick, machineId);
    }
    case "recreate": {
      // Slice 4: playing once solo or the session has started; waiting for others before.
      const session =
        step.sessionId === undefined ? undefined : ctx.state.social.sessions[step.sessionId];
      const playing = step.role === "solo" || session?.startedTick !== undefined;
      return makeAction("recreate", playing ? "playing" : "waiting", tick);
    }
    case "confer":
      return makeAction("confer", "talking", tick);
    case "hold":
      if (step.hold === "sleep") return makeAction("sleep", "asleep", tick);
      if (step.hold === "rest") return makeAction("wait", "waiting", tick);
      if (step.hold === "socialize") return makeAction("chat", "talking", tick);
      return makeAction("operateStation", "operating", tick, machineId);
  }
}

/** Bring the actor's action and label up to date with the step they are on. */
export function refreshPresentation(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind === "idle") return;
  const step = activity.plan?.steps[activity.plan.stepIndex];
  if (step !== undefined) {
    const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
    const next = actionFor(ctx, task, step);
    const current = activity.action;
    if (
      current.kind !== next.kind ||
      current.stage !== next.stage ||
      current.targetId !== next.targetId
    ) {
      activity.action = next;
      emitSim(ctx, "actionStarted", [actor.id], { action: next.kind });
    }
    if (step.kind === "work" && step.stage === "eat" && step.ticksNeeded > 0) {
      activity.action.progress = Math.min(1, step.ticksDone / step.ticksNeeded);
    }
  }
  const label = labelFor(ctx, actor);
  if (activity.label !== label) activity.label = label;
}
