/**
 * Claims (SD §14.5): a lease on a task slot by one actor. Created when an actor starts a task,
 * renewed every tick the actor keeps working it, released on interruption/failure/incapacity,
 * and expired by the derivation pass if the owner stopped renewing.
 *
 * W4a decision (PLAN §6 staging): claims are public in V1 — the AgentView exposes every claim's
 * owner as `TaskView.knownClaimantId` rather than routing it through `taskClaim` facts. The
 * `Claim` record itself is unchanged, so moving to fact-based claim knowledge later only touches
 * the view builder.
 */
import { configTicks } from "../../core/clock";
import { isInDockArea } from "../../core/docks";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { TaskReleaseReason } from "../../core/types/events";
import type { ActorId, ClaimId, ItemId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Task } from "../../core/types/work";
import { emitSim } from "./events";

export function claimTask(ctx: StepCtx, actor: Actor, task: Task): ClaimId {
  const id = allocateId(ctx.state, "claim");
  ctx.state.work.claims[id] = {
    id,
    taskId: task.id,
    ownerActorId: actor.id,
    claimedTick: ctx.tick,
    expiresAtTick: ctx.tick + configTicks(ctx.config, ctx.config.work.claimLeaseSeconds),
  };
  const existing = task.claimState.kind === "claimed" ? task.claimState.claimIds : [];
  task.claimState = { kind: "claimed", claimIds: [...existing, id] };
  task.status = "claimed";
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete task.blockage;
  emitSim(ctx, "taskClaimed", [actor.id, task.id], { taskId: task.id, claimId: id });
  return id;
}

export function renewClaim(ctx: StepCtx, claimId: ClaimId): void {
  const claim = ctx.state.work.claims[claimId];
  if (claim === undefined) return;
  claim.expiresAtTick = ctx.tick + configTicks(ctx.config, ctx.config.work.claimLeaseSeconds);
}

function dropClaim(ctx: StepCtx, task: Task, claimId: ClaimId): void {
  delete ctx.state.work.claims[claimId];
  if (task.claimState.kind !== "claimed") return;
  const rest = task.claimState.claimIds.filter((id) => id !== claimId);
  task.claimState = rest.length === 0 ? { kind: "unclaimed" } : { kind: "claimed", claimIds: rest };
  if (rest.length === 0 && (task.status === "claimed" || task.status === "active")) {
    task.status = "pending";
  }
}

/** Release `actorId`'s claim on `task` (if any). */
export function releaseActorClaim(
  ctx: StepCtx,
  actorId: ActorId,
  task: Task,
  reason: TaskReleaseReason,
): void {
  for (const claim of Object.values(ctx.state.work.claims)) {
    if (claim.taskId !== task.id || claim.ownerActorId !== actorId) continue;
    dropClaim(ctx, task, claim.id);
    emitSim(ctx, "taskReleased", [actorId, task.id], { taskId: task.id, reason });
  }
}

/** Release every claim on `task`. */
export function releaseClaimsForTask(ctx: StepCtx, task: Task, reason: TaskReleaseReason): void {
  const owners = new Set(
    Object.values(ctx.state.work.claims)
      .filter((claim) => claim.taskId === task.id)
      .map((claim) => claim.ownerActorId),
  );
  for (const owner of owners) releaseActorClaim(ctx, owner, task, reason);
}

/** Does truth satisfy the task's completion predicate? (SD §14.4: checked against truth.) */
export function isCompletionMet(
  state: ReadonlyWorldState,
  content: StepCtx["content"],
  task: Task,
): boolean {
  const completion = task.completion;
  switch (completion.kind) {
    case "problemResolved":
    case "stageReached":
      return state.work.problems[task.problemId]?.status === "resolved";
    case "stepsDone":
      // D47: the plan's last step was the commit (a purchase); running out of steps is the proof.
      return true;
    case "itemInZone": {
      const location = state.items[completion.itemId]?.location;
      if (location?.kind !== "onDeck") return false;
      const zone = content.decks[location.deckId]?.zones.find((z) => z.key === completion.zoneKey);
      const x = Math.floor(location.x);
      const y = Math.floor(location.y);
      return zone?.tiles.some((t) => t.x === x && t.y === y) ?? false;
    }
    case "itemInStore": {
      const location = state.items[completion.itemId]?.location;
      return (
        location?.kind === "inExternalStore" &&
        location.portId === completion.portId &&
        location.storeKey === completion.storeKey
      );
    }
    case "itemInDockArea": {
      const location = state.items[completion.itemId]?.location;
      if (location === undefined || state.deck.dock?.dockId !== completion.dockId) return false;
      return isInDockArea(content, state, location, completion.area);
    }
  }
}

/** Custody completions: the haul's completion is the custody change itself (see below). */
function custodyHaul(
  completion: Task["completion"],
): { readonly itemId: ItemId; readonly to: "ship" | "port" } | undefined {
  switch (completion.kind) {
    case "itemInZone":
      return { itemId: completion.itemId, to: "ship" };
    case "itemInStore":
    case "itemInDockArea":
      return { itemId: completion.itemId, to: "port" };
    default:
      return undefined;
  }
}

/**
 * Mark `task` completed and drop its claims. W4a decision: for item-custody predicates
 * (`itemInZone`/`itemInStore`) the work system also resolves the still-open problem, because the
 * haul's completion *is* the custody change and commerce has no separate observer for it.
 */
export function completeTask(ctx: StepCtx, task: Task): void {
  if (task.status === "completed") return;
  const workers: ActorId[] = [];
  for (const claim of Object.values(ctx.state.work.claims)) {
    if (claim.taskId !== task.id) continue;
    workers.push(claim.ownerActorId);
    dropClaim(ctx, task, claim.id);
  }
  task.status = "completed";
  task.claimState = { kind: "unclaimed" };
  const haul = custodyHaul(task.completion);
  emitSim(ctx, "taskCompleted", [task.id, task.problemId, ...workers], {
    taskId: task.id,
    ...(haul === undefined ? {} : { haul }),
  });
  const problem = ctx.state.work.problems[task.problemId];
  if (haul !== undefined && problem !== undefined && problem.status === "open") {
    problem.status = "resolved";
    emitSim(ctx, "problemResolved", [problem.id], { problemId: problem.id, kind: problem.kind });
  }
}
