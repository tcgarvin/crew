/**
 * Dock hands (Dockside §4, §dock-hand-errands): the appear, vanish and move points for freight,
 * done on foot by a local.
 *
 * - An offer staged on the dock: a dock hand comes out of the warehouse door with its crates and
 *   sets them down on the staging area; until then the job is offered with no crates.
 * - An offer withdrawn (declined, expired, or still open when departure prep begins): a dock hand
 *   walks out to its crates, picks them up (they leave the world), and carts them back in.
 * - A delivery done (every unload at the port finished, the crates in the delivery bay, the job
 *   paid on the bay): the job's receiver (the floor set's dock hand for it) or a new dock hand
 *   walks to the bay, takes the crates into the warehouse store, and goes back in.
 *
 * Scripted and robust: commerce dispatches and drives the errands (this file); travel walks the
 * locals (`travel/locals.ts`). An errand with no route, or one running past
 * `travel.dockHandGiveUpSeconds`, does the instant behaviour at once and says so
 * (`dockHandGaveUp`); the dock being cast off does the same for whatever is still open
 * (`travel/locals.ts` `dismissLocals`). A dock with no warehouse-door post (hand-built test docks)
 * has no dock hands: the instant behaviour runs as before. Departure never waits on a dock hand:
 * nothing here is cargo work, and locals are not people ashore.
 */
import { configTicks } from "../../core/clock";
import {
  type BerthedDock,
  dockAlongside,
  dockAlongsideAt,
  dockPost,
  isInDockArea,
  postTile,
} from "../../core/docks";
import { DOCK_HAND_ROLE, dockHandName } from "../../core/floor-set";
import { placeLocal } from "../../core/locals";
import type { TileCoord } from "../../core/types/common";
import type { DockHandErrand, Local } from "../../core/types/dockside";
import type { ItemDefId, ItemId, JobId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Job } from "../../core/types/travel";
import { takeCratesIntoStore, withdrawJobCrates } from "../travel/dock-custody";
import { sendLocalAway, sendLocalTo, settleLocal, standingOn } from "../travel/locals";
import { offerStagingDock, stageOfferedFreight, stagingTilesFreeFirst } from "./jobs";

type Ctx = StepCtx;
type ErrandKind = DockHandErrand["kind"];

const tileOf = (p: { x: number; y: number }): TileCoord => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
});

/** The local running `kind` for `jobId`, if any. */
export function errandFor(
  ctx: Pick<Ctx, "state">,
  jobId: JobId,
  kind: ErrandKind,
): Local | undefined {
  return Object.values(ctx.state.dockside.locals).find(
    (l) => l.errand?.jobId === jobId && l.errand.kind === kind,
  );
}

function crateDefs(ctx: Ctx, itemIds: readonly ItemId[]): ItemDefId[] {
  return itemIds.flatMap((id) => {
    const item = ctx.state.items[id];
    return item === undefined ? [] : [item.defId];
  });
}

function jobDefs(job: Job): ItemDefId[] {
  return job.cargo.flatMap((line) => Array.from({ length: line.count }, () => line.itemDefId));
}

function crateCount(n: number): string {
  return n === 1 ? "a crate" : `${n} crates`;
}

/** The first of `itemIds` lying on the dock floor, as a tile: where a dock hand walks to. */
function firstCrateTile(ctx: Ctx, itemIds: readonly ItemId[]): TileCoord | undefined {
  for (const id of itemIds) {
    const location = ctx.state.items[id]?.location;
    if (location?.kind === "onDeck") return tileOf(location);
  }
  return undefined;
}

/** A new dock hand standing in the warehouse door, or undefined if the door is crowded out. */
function spawnDockHand(
  ctx: Ctx,
  berth: BerthedDock,
  key: string,
  label: string,
): Local | undefined {
  const door = dockPost(berth.dock, "warehouseDoor");
  const presence = ctx.state.deck.dock;
  if (door === undefined || presence === undefined) return undefined;
  const shuffle = configTicks(ctx.config, ctx.config.travel.localShuffleSeconds);
  return placeLocal(
    ctx.state,
    ctx.content,
    presence,
    berth,
    {
      name: dockHandName(ctx.content, ctx.state.seed, key),
      role: DOCK_HAND_ROLE,
      origin: { kind: "dockHand" },
      postKey: door.key,
      label,
    },
    ctx.tick,
    shuffle,
  );
}

function gaveUp(ctx: Ctx, local: Local, errand: DockHandErrand, reason: "noRoute" | "timeout") {
  const portId = dockAlongside(ctx.content, ctx.state)?.dock.portId;
  ctx.emit({
    type: "dockHandGaveUp",
    subjectIds: [local.id, errand.jobId],
    causeIds: [],
    source: "sim",
    ...(portId === undefined ? {} : { locationRef: { kind: "port", portId } }),
    payload: { localId: local.id, jobId: errand.jobId, errand: errand.kind, reason },
  });
}

/** Done with the errand: a spawned dock hand goes back through the door, a receiver stays put. */
function endErrand(ctx: Ctx, local: Local, berth: BerthedDock): void {
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete local.errand;
  if (local.origin.kind !== "dockHand") {
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete local.label;
    local.carrying = [];
    settleLocal(ctx, local);
    return;
  }
  backThroughDoor(ctx, local, berth);
}

/** Send `local` back in through the warehouse door, gone once there; at once with no door. */
function backThroughDoor(ctx: Ctx, local: Local, berth: BerthedDock): void {
  const door = dockPost(berth.dock, "warehouseDoor");
  if (door === undefined) delete ctx.state.dockside.locals[local.id];
  else sendLocalAway(ctx, local, postTile(berth, door));
}

/** Carry the picked-up crates back through the warehouse door, then gone (or settled). */
function carryBackIn(ctx: Ctx, local: Local, berth: BerthedDock, label: string): void {
  const errand = local.errand;
  if (errand === undefined || errand.kind === "stageOffer") return;
  errand.phase = "return";
  local.label = label;
  // A receiver goes in with the delivery too: their job here is done.
  backThroughDoor(ctx, local, berth);
}

/**
 * Do what the errand was for, now, without the walk (the instant behaviour). Used when the walk
 * cannot be made: no route, or past the give-up time.
 */
function finishNow(
  ctx: Ctx,
  local: Local,
  berth: BerthedDock,
  reason: "noRoute" | "timeout",
): void {
  const errand = local.errand;
  if (errand === undefined) return;
  const job = ctx.state.jobs[errand.jobId];
  if (job !== undefined) {
    if (errand.kind === "stageOffer") {
      if (offerStagingDock(ctx, job) !== undefined && job.cargoItemIds.length === 0) {
        stageOfferedFreight(ctx, job);
      }
    } else if (errand.phase === "fetch") {
      if (errand.kind === "withdrawOffer") withdrawJobCrates(ctx, job);
      else takeCratesIntoStore(ctx, job, errand.itemIds, berth.dock.portId);
    }
  }
  gaveUp(ctx, local, errand, reason);
  if (local.origin.kind === "dockHand") {
    delete ctx.state.dockside.locals[local.id];
    return;
  }
  local.carrying = [];
  endErrand(ctx, local, berth);
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

/** An open offer's crates should be on the staging area and are not: bring them out. */
function dispatchStaging(ctx: Ctx, job: Job, berth: BerthedDock): void {
  if (errandFor(ctx, job.id, "stageOffer") !== undefined) return;
  const units = jobDefs(job);
  if (units.length === 0) return;
  const target = stagingTilesFreeFirst(ctx, berth)[0];
  const hand =
    target === undefined
      ? undefined
      : spawnDockHand(ctx, berth, `stage:${job.id}`, `bringing out ${crateCount(units.length)}`);
  if (hand === undefined || target === undefined) {
    stageOfferedFreight(ctx, job);
    return;
  }
  hand.carrying = units;
  hand.errand = { kind: "stageOffer", jobId: job.id, sinceTick: ctx.tick };
  if (!sendLocalTo(ctx, hand, target)) finishNow(ctx, hand, berth, "noRoute");
}

/** A closed or departed-from offer still has crates on the dock: fetch them back in. */
function dispatchWithdrawal(ctx: Ctx, job: Job): void {
  if (errandFor(ctx, job.id, "withdrawOffer") !== undefined) return;
  const berth = dockAlongsideAt(ctx.content, ctx.state, job.fromPortId);
  const target = firstCrateTile(ctx, job.cargoItemIds);
  const hand =
    berth === undefined || target === undefined
      ? undefined
      : spawnDockHand(ctx, berth, `withdraw:${job.id}`, "fetching crates back in");
  if (berth === undefined || hand === undefined || target === undefined) {
    withdrawJobCrates(ctx, job);
    return;
  }
  hand.errand = {
    kind: "withdrawOffer",
    jobId: job.id,
    itemIds: [...job.cargoItemIds],
    phase: "fetch",
    sinceTick: ctx.tick,
  };
  if (!sendLocalTo(ctx, hand, target)) finishNow(ctx, hand, berth, "noRoute");
}

/** Those of `itemIds` lying in the delivery bay of the dock alongside. */
function inDeliveryBay(ctx: Ctx, itemIds: readonly ItemId[]): ItemId[] {
  return itemIds.filter((itemId) => {
    const item = ctx.state.items[itemId];
    return item !== undefined && isInDockArea(ctx.content, ctx.state, item.location, "deliveryBay");
  });
}

/**
 * The crates of `job` the port should take in now: the ones in the delivery bay of the dock
 * alongside, once every unload of the job there is done. Empty otherwise.
 */
function deliveredInBay(ctx: Ctx, job: Job, berth: BerthedDock): ItemId[] {
  const inBay = inDeliveryBay(ctx, job.cargoItemIds);
  if (inBay.length === 0) return [];
  const unloads = Object.values(ctx.state.work.problems).filter(
    (p) =>
      p.kind === "cargoToUnload" &&
      p.payload.jobId === job.id &&
      p.payload.portId === berth.dock.portId,
  );
  if (unloads.length === 0 || unloads.some((p) => p.status === "open")) return [];
  return inBay;
}

/** Delivered crates in the bay: the receiver (or a dock hand) takes them in. */
function dispatchDelivery(ctx: Ctx, job: Job, berth: BerthedDock, itemIds: ItemId[]): void {
  if (errandFor(ctx, job.id, "takeDelivery") !== undefined) return;
  const target = firstCrateTile(ctx, itemIds);
  const label = "collecting the delivery";
  const receiver = Object.values(ctx.state.dockside.locals).find(
    (l) => l.origin.kind === "receiver" && l.origin.jobId === job.id && l.errand === undefined,
  );
  const hand =
    target === undefined
      ? undefined
      : (receiver ?? spawnDockHand(ctx, berth, `deliver:${job.id}`, label));
  if (hand === undefined || target === undefined) {
    takeCratesIntoStore(ctx, job, itemIds, berth.dock.portId);
    return;
  }
  hand.label = label;
  hand.errand = {
    kind: "takeDelivery",
    jobId: job.id,
    itemIds: [...itemIds],
    phase: "fetch",
    sinceTick: ctx.tick,
  };
  if (!sendLocalTo(ctx, hand, target)) finishNow(ctx, hand, berth, "noRoute");
}

// ---------------------------------------------------------------------------------------------
// Driving errands
// ---------------------------------------------------------------------------------------------

/** One tick of one errand: arrival, a moot errand, a failed walk, or the give-up clock. */
function driveErrand(ctx: Ctx, local: Local, berth: BerthedDock, giveUpTicks: number): void {
  const errand = local.errand;
  if (errand === undefined) return;
  const job = ctx.state.jobs[errand.jobId];
  if (errand.kind !== "stageOffer" && errand.phase === "return") return; // walking back in
  if (errand.kind === "stageOffer") {
    // Taken (accepting stages at once), closed, or the ship is leaving: nothing to set down.
    const moot =
      job === undefined || job.cargoItemIds.length > 0 || offerStagingDock(ctx, job) === undefined;
    if (moot) {
      local.carrying = [];
      endErrand(ctx, local, berth);
      return;
    }
  } else if (job === undefined || errand.itemIds.every((id) => ctx.state.items[id] === undefined)) {
    endErrand(ctx, local, berth);
    return;
  }
  if (ctx.tick - errand.sinceTick >= giveUpTicks) {
    finishNow(ctx, local, berth, "timeout");
    return;
  }
  const behaviour = local.behaviour;
  if (behaviour.kind !== "walkTo" || local.movement.kind === "moving") return;
  if (!standingOn(local, behaviour.tile)) {
    // The walk stopped short (a tile turned unwalkable): try again, or give up.
    if (!sendLocalTo(ctx, local, behaviour.tile)) finishNow(ctx, local, berth, "noRoute");
    return;
  }
  if (job === undefined) return;
  switch (errand.kind) {
    case "stageOffer":
      local.carrying = [];
      stageOfferedFreight(ctx, job);
      endErrand(ctx, local, berth);
      return;
    case "withdrawOffer":
      local.carrying = crateDefs(ctx, job.cargoItemIds);
      withdrawJobCrates(ctx, job);
      carryBackIn(ctx, local, berth, `taking ${crateCount(local.carrying.length)} back in`);
      return;
    case "takeDelivery": {
      const still = inDeliveryBay(ctx, errand.itemIds);
      local.carrying = crateDefs(ctx, still);
      takeCratesIntoStore(ctx, job, still, berth.dock.portId);
      carryBackIn(ctx, local, berth, "taking the delivery in");
      return;
    }
  }
}

/**
 * Every tick, after the job sweep: the dock's freight is where §offered-freight says it should be,
 * by way of a dock hand where the dock has a warehouse door (§dock-hand-errands) and at once where
 * it has none.
 */
export function syncDockFreight(ctx: Ctx): void {
  const berth = dockAlongside(ctx.content, ctx.state);
  for (const job of Object.values(ctx.state.jobs)) {
    if (job.status === "offered") {
      const stagingDock = offerStagingDock(ctx, job);
      if (stagingDock !== undefined && job.cargoItemIds.length === 0) {
        if (dockPost(stagingDock.dock, "warehouseDoor") === undefined)
          stageOfferedFreight(ctx, job);
        else dispatchStaging(ctx, job, stagingDock);
      } else if (stagingDock === undefined && job.cargoItemIds.length > 0) {
        withdrawOffer(ctx, job);
      }
    } else if (job.status === "declined" || job.status === "expired") {
      if (job.cargoItemIds.length > 0) withdrawOffer(ctx, job);
    }
    if (berth !== undefined) {
      const inBay = deliveredInBay(ctx, job, berth);
      if (inBay.length > 0) {
        if (dockPost(berth.dock, "warehouseDoor") === undefined) {
          takeCratesIntoStore(ctx, job, inBay, berth.dock.portId);
        } else dispatchDelivery(ctx, job, berth, inBay);
      }
    }
  }
  if (berth === undefined) return;
  const giveUpTicks = configTicks(ctx.config, ctx.config.travel.dockHandGiveUpSeconds);
  for (const local of Object.values(ctx.state.dockside.locals)) {
    if (ctx.state.dockside.locals[local.id] === undefined) continue; // gone this tick
    driveErrand(ctx, local, berth, giveUpTicks);
  }
}

function withdrawOffer(ctx: Ctx, job: Job): void {
  const berth = dockAlongsideAt(ctx.content, ctx.state, job.fromPortId);
  if (berth === undefined || dockPost(berth.dock, "warehouseDoor") === undefined) {
    withdrawJobCrates(ctx, job);
    return;
  }
  dispatchWithdrawal(ctx, job);
}
