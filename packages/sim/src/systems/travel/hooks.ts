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
import { jobInHand } from "./in-hand";

export { raiseHookIfIdle };

/** A passenger is walking down the ramp (§3.5/§4.2): the captain is not looking for work yet. */
function somebodyDisembarking(ctx: StepCtx): boolean {
  return Object.values(ctx.state.actors).some((a) => a.disembarking === true);
}

/**
 * Whether the captain has nothing on at `portId`: no offer open here, no job in hand anywhere
 * (`jobInHand`), no passenger walking off, no job decision queued, no course planned, no voyage
 * under way, and no offer here declined or expired within `config.commerce.reofferSeconds`.
 */
function captainIsIdleAt(ctx: StepCtx, portId: PortDefId): boolean {
  const travel = ctx.state.travel;
  if (travel.stage === "docked" && travel.plannedDestinationId !== undefined) return false;
  // §2.3: a waypoint of a voyage is a stop on the way, not a port to look for work at.
  if (travel.voyageDestinationId !== undefined) return false;
  if (somebodyDisembarking(ctx)) return false;
  const decisions = ctx.state.decisions;
  if (decisions.queue.some((id) => decisions.records[id]?.jobId !== undefined)) return false;
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

/**
 * `jobBoard` (D40; D46 as amended): the captain looking for work. Raised once per docking, when
 * the ship is docked and `captainIsIdleAt` holds; the narrator answers it with an offer or,
 * deliberately, with nothing. `jobBoardLastAsk` records the docking it fired in and is cleared
 * the moment travel leaves `docked`, so the next docking at any port asks again. It is never
 * re-raised on a timer: the owner withdrew D46's re-ask so no clock pushes the narrator toward
 * "offer work now"; pacing is its own judgement, and `quietTooLong` is the only recurring hook.
 * D66: `stageDock` (the staging call before docking) offers nothing, so it never keeps the board
 * quiet; an offer made in flight by a story hook does.
 */
export function raiseJobBoardHookIfNeeded(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.narrator.jobBoardLastAsk;
    return;
  }
  if (ctx.state.narrator.jobBoardLastAsk?.portId === travel.portId) return;
  if (!captainIsIdleAt(ctx, travel.portId)) return;
  if (raiseHookIfIdle(ctx, "jobBoard", { portId: travel.portId })) {
    ctx.state.narrator.jobBoardLastAsk = { portId: travel.portId, tick: ctx.tick };
  }
}
