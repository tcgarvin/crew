/**
 * The helm as the duty station (D77): who stands it, the plan to take it, the handover, the
 * hold, and gangway watch in port.
 *
 * Owner: W1 of ship life slice 2. Gate B stubs keep today's behaviour: `helmManned` is the old
 * travel staffing rule (anyone aboard within a tile of the console), `helmPlan` today's walk to
 * the operate position and hold, `helmHoldDone` today's end-of-hold rule, nobody is anyone's
 * stander (`helmRoleOf` is `none`) and nothing stands gangway watch.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { HelmRole } from "../../core/types/view";
import type { ActivityStep, Task } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { operateTiles } from "../travel/tasks";
import { type PlanResult, interactionTarget } from "../work/plans";
import type { StepResult } from "../work/steps";
import { isOnWatch } from "./duty";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

/** The ship's helm: a `pilotStation` machine whose def requires an operator. */
export function helmMachine(
  state: Pick<ReadonlyWorldState, "machines">,
  content: Pick<ContentBundle, "machines">,
): DeepReadonly<Machine> | undefined {
  return Object.values(state.machines).find((m) => {
    const def = content.machines[m.defId];
    return def?.tags.includes("pilotStation") && def.operation.requiresOperator === true;
  });
}

/**
 * Is the helm manned (or is there none to man)? Stub: the pre-watch rule, any crew member aboard
 * (not a passenger) within 1 tile of one of the helm's `operate` positions. W1: the actor
 * `whoHasTheHelm` names.
 */
export function helmManned(state: ReadonlyWorldState, content: ContentBundle): boolean {
  const helm = helmMachine(state, content);
  if (helm === undefined) return true;
  const positions = operateTiles({ state, content }, helm.id);
  if (positions.length === 0) return true;
  const deckId = shipDeckId(state);
  return Object.values(state.actors).some((actor) => {
    const location = actor.location;
    // Passengers §3.2: a passenger standing by the console is not staffing it.
    if (!actor.crew || actor.passenger === true) return false;
    if (location.kind !== "onDeck" || location.deckId !== deckId) return false;
    return positions.some(
      (p) => Math.abs(location.x - (p.x + 0.5)) <= 1 && Math.abs(location.y - (p.y + 0.5)) <= 1,
    );
  });
}

/**
 * The actor holding the helm: a `staff` hold on a helm task, standing on the seat. Stub: nobody
 * (W1).
 */
export function whoHasTheHelm(
  _state: ReadonlyWorldState,
  _content: ContentBundle,
): ActorId | undefined {
  return undefined;
}

/** What `actorId` is to the helm now (`SelfView.watch.helmRole`). Stub: `none` (W1). */
export function helmRoleOf(
  _state: ReadonlyWorldState,
  _config: ConfigDef,
  _actorId: ActorId,
): HelmRole {
  return "none";
}

/**
 * Officer of the watch: the captain or first officer of the section on watch, unless they are
 * its helm-stander.
 */
export function isOfficerOfTheWatch(
  state: ReadonlyWorldState,
  config: ConfigDef,
  actorId: ActorId,
  tick: number,
): boolean {
  const actor = state.actors[actorId];
  if (actor === undefined) return false;
  if (!actor.roleTags.some((role) => role === "captain" || role === "firstOfficer")) return false;
  if (!isOnWatch(actor.schedule, tick, config)) return false;
  return helmRoleOf(state, config, actorId) !== "stander";
}

/**
 * The plan for a `staffStation` task. Stub: walk to the `operate` position and hold (W1: by way
 * of the `standby` position and a handover).
 */
export function helmPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "machine") return { ok: false, reason: "unreachableTarget" };
  const target = interactionTarget(ctx, actor, task.target.machineId, "operate");
  if (target === undefined) return { ok: false, reason: "unreachableTarget" };
  return {
    ok: true,
    plan: {
      steps: [
        { kind: "moveTo", target, requested: false },
        { kind: "hold", hold: "staff", sinceTick: ctx.tick },
      ],
      stepIndex: 0,
    },
  };
}

/**
 * The `handover` work step at the standby position. Counts `watches.handoverSeconds` only while
 * someone else holds the seat, else is done at once. Stub: done at once (nobody holds it,
 * `whoHasTheHelm`); W1 counts and records `watch.helm.relievedAt`.
 */
export function runHandover(_ctx: StepCtx, _actor: Actor, _step: StepOf<"work">): StepResult {
  return "done";
}

/**
 * Does a `staff` hold end? Stub: today's rule, once the task's problem is no longer open while
 * docked or in transit (W1: relieved since the hold began, or the problem not open).
 */
export function helmHoldDone(ctx: StepCtx, actor: Actor, _step: StepOf<"hold">): boolean {
  const activity = actor.activity;
  const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
  const resolved = task === undefined || ctx.state.work.problems[task.problemId]?.status !== "open";
  const stage = ctx.state.travel.stage;
  return resolved && (stage === "docked" || stage === "transit");
}

/** Gangway watch (`standWatch`): to the airlock's `gangway` zone and hold. Stub: blocked (W1). */
export function gangwayPlan(_ctx: StepCtx, _actor: Actor): PlanResult {
  return { ok: false, reason: "unreachableTarget" };
}

/**
 * Does a `gangway` hold end? W1: the ship is not docked, or they are no longer the stander. Stub:
 * nothing plans one, so a hold that somehow exists is not kept.
 */
export function gangwayHoldDone(_ctx: StepCtx, _actor: Actor, _step: StepOf<"hold">): boolean {
  return true;
}
