/**
 * The two ways freight leaves the dock into the port (D63, D66), shared by commerce (a dock hand
 * picking crates up, or the instant behaviour at a dock with no warehouse door) and travel (the
 * dock being cast off with a dock hand's errand still open).
 *
 * - `withdrawJobCrates`: an offer's crates go back in: they leave the world, as D63 had it.
 * - `takeCratesIntoStore`: delivered crates go through the warehouse door into its store, the
 *   custody `deliveryComplete` already accepted on the bay.
 */
import { rebuildItemIndexes } from "../../core/caches";
import type { ItemId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Job } from "../../core/types/travel";
import { portStoreLocation } from "./stores";

type Ctx = Pick<StepCtx, "state" | "caches" | "defs" | "emit">;

/** An offer's staged crates are carted back in and leave the world (`freightWithdrawn`). */
export function withdrawJobCrates(ctx: Ctx, job: Job): void {
  if (job.cargoItemIds.length === 0) return;
  for (const itemId of job.cargoItemIds) delete ctx.state.items[itemId];
  job.cargoItemIds = [];
  ctx.caches.dirty.inventory = true;
  rebuildItemIndexes(ctx.state, ctx.caches.index);
  ctx.emit({
    type: "freightWithdrawn",
    subjectIds: [job.id],
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId: job.fromPortId },
    payload: { jobId: job.id, portId: job.fromPortId },
  });
}

/** Crates set down at `portId` go into its warehouse store (`cargoTransferred` each). */
export function takeCratesIntoStore(
  ctx: Ctx,
  job: Pick<Job, "id">,
  itemIds: readonly ItemId[],
  portId: PortDefId,
): void {
  const store = portStoreLocation(ctx.defs.port(portId));
  let moved = false;
  for (const itemId of itemIds) {
    const item = ctx.state.items[itemId];
    if (item === undefined) continue;
    const from = item.location;
    item.location = store;
    moved = true;
    ctx.emit({
      type: "cargoTransferred",
      subjectIds: [itemId, job.id],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "port", portId },
      payload: { itemId, from, to: store },
    });
  }
  if (!moved) return;
  ctx.caches.dirty.inventory = true;
  rebuildItemIndexes(ctx.state, ctx.caches.index);
}
