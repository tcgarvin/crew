/**
 * Narrator hook points owned by travel/commerce (PLAN §6 W6 item 5, D5).
 *
 * `NarratorHook` halts `advance()` (see `world.ts` `haltReason`); only one hook may be pending
 * at a time, so every call here is a no-op while one already is. `raiseHookIfIdle` itself moved
 * to `core/hooks.ts` (D37) and is re-exported here for the systems that import it from travel.
 */
import { configTicks } from "../../core/clock";
import { raiseHookIfIdle } from "../../core/hooks";
import type { PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";

export { raiseHookIfIdle };

/**
 * Whether the captain has nothing on at `portId`: no offer open here, no job accepted anywhere,
 * no job decision queued, no course planned, and no offer here declined or expired within
 * `config.commerce.reofferSeconds`.
 */
function captainIsIdleAt(ctx: StepCtx, portId: PortDefId): boolean {
  const travel = ctx.state.travel;
  if (travel.stage === "docked" && travel.plannedDestinationId !== undefined) return false;
  const decisions = ctx.state.decisions;
  if (decisions.queue.some((id) => decisions.records[id]?.jobId !== undefined)) return false;
  const cooldownTicks = configTicks(ctx.config, ctx.config.commerce.reofferSeconds);
  for (const job of Object.values(ctx.state.jobs)) {
    if (job.status === "accepted") return false;
    if (job.fromPortId !== portId) continue;
    if (job.status === "offered") return false;
    if (
      (job.status === "declined" || job.status === "expired") &&
      job.closedTick !== undefined &&
      ctx.tick - job.closedTick < cooldownTicks
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `jobBoard` (D40, D46): the captain looking for work. Raised when the ship is docked and
 * `captainIsIdleAt` holds, and raised again, not more often than `config.commerce.reofferSeconds`,
 * for as long as the captain stays idle there: an unanswered ask (the narrator offered nothing)
 * must not leave the port without work until something else happens. `jobBoardLastAsk` records
 * the port and tick of the last ask; a different port asks at once. `approachingPort` is raised
 * by travel before docking and is unaffected: an offer made there keeps the board quiet here.
 */
export function raiseJobBoardHookIfNeeded(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return;
  const last = ctx.state.narrator.jobBoardLastAsk;
  if (last !== undefined && last.portId === travel.portId) {
    const cooldownTicks = configTicks(ctx.config, ctx.config.commerce.reofferSeconds);
    if (ctx.tick - last.tick < cooldownTicks) return;
  }
  if (!captainIsIdleAt(ctx, travel.portId)) return;
  if (raiseHookIfIdle(ctx, "jobBoard", { portId: travel.portId })) {
    ctx.state.narrator.jobBoardLastAsk = { portId: travel.portId, tick: ctx.tick };
  }
}
