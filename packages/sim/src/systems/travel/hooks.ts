/**
 * Narrator hook points owned by travel/commerce (PLAN §6 W6 item 5, D5).
 *
 * `NarratorHook` halts `advance()` (see `world.ts` `haltReason`); only one hook may be pending
 * at a time, so every call here is a no-op while one already is. `raiseHookIfIdle` itself moved
 * to `core/hooks.ts` (D37) and is re-exported here for the systems that import it from travel.
 *
 * D70: the `captainAshore` ask (which replaced `jobBoard`) is raised by commerce when the captain
 * steps onto the dock looking for work (`systems/commerce/captain-ashore.ts`); whether there is
 * anything to look for is `captainIsIdleAt`, here.
 */
import { configTicks } from "../../core/clock";
import { raiseHookIfIdle } from "../../core/hooks";
import type { PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { jobInHand } from "./in-hand";

export { raiseHookIfIdle };

/** A passenger is walking down the ramp (§3.5/§4.2): the captain is not looking for work yet. */
function somebodyDisembarking(ctx: Pick<StepCtx, "state">): boolean {
  return Object.values(ctx.state.actors).some((a) => a.disembarking === true);
}

/**
 * Whether the captain has nothing on at `portId`: no offer open here, no job in hand anywhere
 * (`jobInHand`), no passenger walking off, no job decision queued, no card waiting to be delivered
 * in person (D70), no course planned, no voyage under way, and no offer here declined or expired
 * within `config.commerce.reofferSeconds`.
 */
export function captainIsIdleAt(
  ctx: Pick<StepCtx, "state" | "config" | "tick">,
  portId: PortDefId,
): boolean {
  const travel = ctx.state.travel;
  if (travel.stage === "docked" && travel.plannedDestinationId !== undefined) return false;
  // §2.3: a waypoint of a voyage is a stop on the way, not a port to look for work at.
  if (travel.voyageDestinationId !== undefined) return false;
  if (somebodyDisembarking(ctx)) return false;
  const decisions = ctx.state.decisions;
  if (decisions.queue.some((id) => decisions.records[id]?.jobId !== undefined)) return false;
  if (decisions.held.length > 0) return false;
  const cooldownTicks = configTicks(ctx.config, ctx.config.commerce.reofferSeconds);
  for (const job of Object.values(ctx.state.jobs)) {
    if (jobInHand(job)) return false;
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
