/**
 * Expeditions A2 (§6, plan calls 5 and 11): the errand's ending. `settleErrand` writes
 * `Job.errand.outcome` when the expedition resolves (the captive's passage, `endPassageEarly` in
 * `commerce/passage.ts`, is the only other writer: a captive put off fails the errand after all);
 * commerce asks `errandFulfilled` whether an errand without a passage has earned its pay
 * (`jobFulfilled`).
 *
 * The outcome, from the expedition's: `targetTaken` with the target alive is `broughtAlive` (the
 * target is removed and boards anew as the captive, `spawnCaptive`, since `castAfter` removes a
 * taken target and the aftermath every actor with a combatant); `targetTaken` with the target dead
 * is `broughtDead` when the job wants it dead or either way, else `failed`; a `fetchItem` taken is
 * `broughtItem` once its item is stowed aboard; anything else (`targetFled`, `partyWithdrew`,
 * `partyRouted`, `timedOut`) is `failed`, which fails the job there and then (`jobFailed`). Every
 * outcome sets the voyage home, `returnToPortId`: travel plans the hop once nothing holds the ship.
 *
 * Owner after the gate: W1 of expeditions A2.
 */
import { isOnDock } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { PhysicalLocation } from "../../core/types/common";
import type { ItemDefId, ItemId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { ExpeditionOutcome } from "../../core/types/state";
import type { ErrandOutcome, Job, JobErrand } from "../../core/types/travel";
import { shipDeckId } from "../../core/world";
import { cargoStowageZoneKey, deliveryComplete } from "../commerce/jobs";
import { spawnCaptive } from "../commerce/passage";
import type { Fight } from "./combat";
import { distance } from "./ground";

/**
 * Call 5: settle the errand of the expedition that just resolved with `outcome` (the job by
 * `expedition.jobId`; none, nothing to settle). Called by `resolve()` after `afterTheFight` and
 * before the party and the cast leave the fight.
 */
export function settleErrand(fight: Fight, outcome: ExpeditionOutcome): void {
  const { ctx, expedition } = fight;
  const jobId = expedition.jobId;
  if (jobId === undefined) return;
  const job = ctx.state.jobs[jobId];
  const errand = job?.errand;
  if (job === undefined || errand === undefined) {
    throw new Error(`settleErrand: the expedition's job "${jobId}" is not an errand on record`);
  }
  if (errand.outcome !== undefined) {
    throw new Error(`settleErrand: errand "${jobId}" is already settled (${errand.outcome})`);
  }
  const target = fight.people.find(
    (p) => p.combatant?.disposition.part === "target" && ctx.state.actors[p.id] !== undefined,
  );
  let settled = errandOutcome(errand, outcome, target);
  if (settled === "broughtAlive" && target !== undefined) spawnCaptive(ctx, job, target);
  if (settled === "broughtItem" && !stowFetchedItem(fight, job, errand)) settled = "failed";
  errand.outcome = settled;
  if (settled === "failed") {
    job.status = "failed";
    job.closedTick = ctx.tick;
    ctx.emit({
      type: "jobFailed",
      subjectIds: [job.id],
      causeIds: [],
      source: "sim",
      payload: { jobId: job.id, outcome: "failed" },
    });
  }
  // The ship goes home whatever happened. Only the voyage: travel plans the hop once nothing holds
  // the ship at a waypoint (a card on the table, a hold for repairs), and prep calls everyone aboard.
  ctx.state.travel.voyageDestinationId = errand.returnToPortId;
}

/** The errand's outcome for the expedition's (the module comment); `target` while still here. */
function errandOutcome(
  errand: Readonly<JobErrand>,
  outcome: ExpeditionOutcome,
  target: Actor | undefined,
): ErrandOutcome {
  if (outcome !== "targetTaken") return "failed";
  if (errand.kind === "fetchItem") return "broughtItem";
  if (target === undefined) return "failed";
  if (target.availability !== "dead") return "broughtAlive";
  return errand.wants === "alive" ? "failed" : "broughtDead";
}

/**
 * A `fetchItem` taken: its item (in a party member's hands, else on the site floor nearest the
 * loot post) goes into the ship's cargo stowage as the job's one manifest line, so the unload at
 * the return port and `deliveryComplete` pay it as freight. False when there is no such item.
 */
function stowFetchedItem(fight: Fight, job: Job, errand: Readonly<JobErrand>): boolean {
  const { ctx } = fight;
  const itemDefId = errand.itemDefId;
  if (itemDefId === undefined) {
    throw new Error(`settleErrand: fetchItem "${job.id}" names no item`);
  }
  const itemId = fetchedItem(fight, itemDefId);
  const item = itemId === undefined ? undefined : ctx.state.items[itemId];
  const stowage = stowageLocation(ctx);
  if (item === undefined || stowage === undefined) return false;
  item.location = stowage;
  item.jobId = job.id;
  job.cargo = [{ itemDefId, count: 1 }];
  job.cargoItemIds = [item.id];
  ctx.caches.dirty.inventory = true;
  return true;
}

/** The errand's item: carried by the party, else on the site floor nearest the loot post. */
function fetchedItem(fight: Fight, itemDefId: ItemDefId): ItemId | undefined {
  const { ctx, expedition } = fight;
  const party = new Set<string>(expedition.party);
  const loot = fight.ground.posts.loot;
  let best: { id: ItemId; score: number } | undefined;
  for (const item of Object.values(ctx.state.items)) {
    if (item.defId !== itemDefId || item.jobId !== undefined) continue;
    const at = item.location;
    if ((at.kind === "carriedBy" || at.kind === "equippedBy") && party.has(at.actorId)) {
      return item.id;
    }
    if (at.kind !== "onDeck" || !isOnDock(ctx.content, ctx.state, at)) continue;
    const tile = { x: Math.floor(at.x), y: Math.floor(at.y) };
    const score = loot === undefined ? 0 : distance(tile, loot);
    if (best === undefined || score < best.score) best = { id: item.id, score };
  }
  return best?.id;
}

/** The first tile of the ship's cargo stowage zone, as a place to set an item down. */
function stowageLocation(ctx: StepCtx): PhysicalLocation | undefined {
  const deckId = shipDeckId(ctx.state);
  const key = cargoStowageZoneKey(ctx);
  const tile = ctx.content.decks[deckId]?.zones.find((z) => z.key === key)?.tiles[0];
  if (tile === undefined) return undefined;
  return { kind: "onDeck", deckId, x: tile.x + 0.5, y: tile.y + 0.5 };
}

/**
 * Has an errand without a passage earned its pay? Brought dead: once the ship is docked at the
 * return port (`toPortId`). Brought an item: once it is delivered there, as freight is. A target
 * brought alive is a passage, paid by the passage rule; a failed or unsettled errand never pays.
 */
export function errandFulfilled(
  state: Pick<ReadonlyWorldState, "items" | "deck" | "travel">,
  content: Pick<StepCtx["content"], "docks" | "decks">,
  job: Pick<Job, "cargoItemIds" | "toPortId" | "errand">,
): boolean {
  const outcome = job.errand?.outcome;
  switch (outcome) {
    case "broughtDead":
      return state.travel.stage === "docked" && state.travel.portId === job.toPortId;
    case "broughtItem":
      return deliveryComplete(state, content, job);
    case "broughtAlive":
    case "failed":
    case undefined:
      return false;
  }
}
