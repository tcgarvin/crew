/**
 * Work-slice invariants for tests (SD §19.4 style): claims point at live tasks and at owners who
 * are actually working them; single-slot tasks have at most one claim; plans are in range. D65: a
 * hand truck is on one trip at most, pushed by that trip's actor, and nothing rides on a truck
 * nobody is pushing.
 */
import type { Actor } from "../../core/types/actor";
import type { ClaimId, ItemId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";

export function workViolations(world: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const { state } = world;
  const perTask = new Map<string, number>();
  for (const claim of Object.values(state.work.claims)) {
    const task = state.work.tasks[claim.taskId];
    const owner = state.actors[claim.ownerActorId];
    if (task === undefined) out.push(`claim ${claim.id} is on missing task ${claim.taskId}`);
    if (owner === undefined) out.push(`claim ${claim.id} has missing owner ${claim.ownerActorId}`);
    else if (!holdsClaim(owner.activity, claim.id)) {
      out.push(`claim ${claim.id} owner ${owner.id} is not working it`);
    }
    perTask.set(claim.taskId, (perTask.get(claim.taskId) ?? 0) + 1);
    if (task !== undefined && (perTask.get(claim.taskId) ?? 0) > task.workerSlots) {
      out.push(`task ${task.id} has more claims than worker slots`);
    }
  }
  for (const actor of Object.values(state.actors)) {
    const activity = actor.activity;
    if (activity.kind === "idle" || activity.plan === undefined) continue;
    const { stepIndex, steps } = activity.plan;
    if (stepIndex < 0 || stepIndex >= steps.length)
      out.push(`actor ${actor.id} plan index ${stepIndex} out of range`);
    if (activity.label === undefined || activity.label.length === 0)
      out.push(`actor ${actor.id} has no label`);
  }
  out.push(...truckViolations(world));
  return out;
}

function holdsClaim(activity: Actor["activity"], id: ClaimId): boolean {
  if (activity.kind !== "task") return false;
  return activity.claimId === id || (activity.haul?.legs ?? []).some((leg) => leg.claimId === id);
}

function truckViolations(world: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const { state, content } = world;
  const users = new Map<ItemId, Actor["id"]>();
  for (const actor of Object.values(state.actors)) {
    const truckId = actor.activity.kind === "task" ? actor.activity.haul?.truckId : undefined;
    if (truckId === undefined) continue;
    const other = users.get(truckId);
    if (other !== undefined) out.push(`truck ${truckId} is on ${other}'s and ${actor.id}'s trips`);
    users.set(truckId, actor.id);
    const location = state.items[truckId]?.location;
    if (location?.kind === "carriedBy" && location.actorId !== actor.id) {
      out.push(`truck ${truckId} is in ${location.actorId}'s hands on ${actor.id}'s trip`);
    }
  }
  for (const item of Object.values(state.items)) {
    const location = item.location;
    if (location.kind !== "inContainer") continue;
    const container = state.items[location.containerId];
    const pusher = users.get(location.containerId);
    if (container === undefined) continue;
    const truck = content.items[container.defId]?.toolKinds.includes("handTruck") ?? false;
    if (pusher === undefined) {
      if (truck)
        out.push(`item ${item.id} rides on truck ${container.id}, which nobody is pushing`);
      continue;
    }
    const held = container.location;
    if (held.kind !== "carriedBy" || held.actorId !== pusher) {
      out.push(`item ${item.id} rides on ${container.id}, which ${pusher} is not pushing`);
    }
  }
  return out;
}
