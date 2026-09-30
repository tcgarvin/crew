/**
 * Work-slice invariants for tests (SD §19.4 style): claims point at live tasks and at owners who
 * are actually working them; single-slot tasks have at most one claim; plans are in range.
 */
import type { World } from "../../core/types/kernel";

export function workViolations(world: Pick<World, "state">): string[] {
  const out: string[] = [];
  const { state } = world;
  const perTask = new Map<string, number>();
  for (const claim of Object.values(state.work.claims)) {
    const task = state.work.tasks[claim.taskId];
    const owner = state.actors[claim.ownerActorId];
    if (task === undefined) out.push(`claim ${claim.id} is on missing task ${claim.taskId}`);
    if (owner === undefined) out.push(`claim ${claim.id} has missing owner ${claim.ownerActorId}`);
    else if (owner.activity.kind !== "task" || owner.activity.claimId !== claim.id) {
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
  return out;
}
