/**
 * Job lifecycle (SD §17.3, PLAN §6 W6 item 3): `offered -> accepted -> inTransit -> delivered ->
 * paid | declined | expired | failed`. A per-tick sweep here pays a job exactly once
 * (`Job.paymentTransactionId` guard) once every line is confirmed delivered.
 *
 * §offered-freight: at a port with a dock map, freight is physical on the dock. An offer's
 * crates are staged on the origin's staging area while the ship is alongside there (`docking` or
 * `docked`), owned by nobody: the job is still `offered`, so no `cargoToLoad` work exists and no
 * crew member touches them. Accepting raises the load work for the crates already there; a
 * declined, expired or departed-from offer has its crates withdrawn. At the destination the crew
 * carry the freight to the delivery bay; the job is delivered when every crate is in the bay,
 * and the crates are then carted into the warehouse store. The carting (out on offer, back
 * on withdrawal, in after delivery) is a dock hand's walk (§dock-hand-errands, `dock-hands.ts`). A
 * port without a dock keeps the store and the transfer tiles.
 */
import type { ApplyCtx, ValidateCtx } from "../../core/commands";
import { queueOrHold } from "../../core/delivery";
import { type BerthedDock, dockAlongsideAt, dockAreaTiles, isInDockArea } from "../../core/docks";
import { allocateId } from "../../core/ids";
import { isSite, portGraph } from "../../core/places";
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type { CargoClass, ExternalStoreDef, PortDef } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type {
  DecisionId,
  ItemDefId,
  ItemId,
  PortDefId,
  ProblemId,
  TransactionId,
} from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { CargoLine, Job, JobIssuer } from "../../core/types/travel";
import type { ProblemOfKind } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { errandFulfilled } from "../expedition/errand";
import { shortestPath } from "../travel/graph";
import { commandActor } from "../travel/roster";
import { portStoreLocation } from "../travel/travel";
import { writeFact } from "../work/facts";
import { awaitsFamiliarityBrief } from "../work/perception";
import { errandPay } from "./errand";

// ---------------------------------------------------------------------------------------------
// Issuers (§issuers-and-pitches)
// ---------------------------------------------------------------------------------------------

/** Role given to an issuer known only by a bare name (old saves, string-issuer drafts). */
const LEGACY_ISSUER_ROLE = "shipper";

/** Text key for the pitch of a job whose draft carried none. */
export const DEFAULT_PITCH_KEY = "job.pitch.default";

/** The one-line display form of an issuer: "Name, Org", or "Name, role" without an org. */
export function issuerLabel(issuer: Readonly<JobIssuer>): string {
  return `${issuer.name}, ${issuer.org ?? issuer.role}`;
}

/**
 * A draft's issuer as a person. A bare string (older drafts) becomes the name with the legacy
 * role; whitespace is trimmed and an empty `org` is dropped, so the result is JSON-safe.
 */
export function normaliseIssuer(issuer: string | Readonly<JobIssuer>): JobIssuer {
  if (typeof issuer === "string") return { name: issuer.trim(), role: LEGACY_ISSUER_ROLE };
  const org = issuer.org?.trim();
  return {
    name: issuer.name.trim(),
    role: issuer.role.trim(),
    ...(org === undefined || org === "" ? {} : { org }),
  };
}

// ---------------------------------------------------------------------------------------------
// Price bands (D6)
// ---------------------------------------------------------------------------------------------

/**
 * Passengers-and-galaxy §2.3: the distance pay is banded over is the shortest path, so a job
 * may name any reachable port and a two-hop haul pays for two legs. The reason when the two
 * ports cannot carry a band: unknown, the same, or no chain of routes between them.
 */
function bandRoute(
  ctx: Pick<StepCtx, "content">,
  fromPortId: PortDefId,
  toPortId: PortDefId,
): { readonly distance: number } | { readonly reason: string } {
  for (const portId of [fromPortId, toPortId]) {
    if (ctx.content.ports[portId] === undefined) return { reason: `unknown port "${portId}"` };
  }
  if (fromPortId === toPortId) return { reason: "destination must differ from the origin" };
  const distance = shortestPath(ctx.content.ports, fromPortId, toPortId)?.distance;
  if (distance === undefined) return { reason: `no route from "${fromPortId}" to "${toPortId}"` };
  return { distance };
}

/** Every cargo line must share one `CargoClass` (the band is keyed by class, not per-item). */
export function cargoClassOf(
  ctx: Pick<StepCtx, "content">,
  cargo: readonly CargoLine[],
): CargoClass | undefined {
  const classes = new Set(
    cargo
      .map((line) => ctx.content.items[line.itemDefId]?.cargoClass)
      .filter((c) => c !== undefined),
  );
  return classes.size === 1 ? [...classes][0] : undefined;
}

/** Total cargo units across all lines (a stack of two crates counts as two). */
function totalCargoUnits(cargo: readonly CargoLine[]): number {
  return cargo.reduce((sum, line) => sum + line.count, 0);
}

/**
 * Owner feedback (2026-09-30): freight now spawns as one item per unit (see `acceptJob` below),
 * so an uncapped job could mean hauling a dozen individual crates one at a time. Trims cargo to
 * at most `config.commerce.maxCratesPerJob` units, dropping from the last line(s) first, and
 * scales `pay` down by the same ratio — price bands are linear in units, so a proportional cut
 * stays inside the band the original pay was chosen from.
 */
export function clampCargoToMaxCrates(
  cargo: readonly CargoLine[],
  pay: number,
  maxCrates: number,
): { cargo: CargoLine[]; pay: number } {
  const units = totalCargoUnits(cargo);
  if (units <= maxCrates || units === 0) return { cargo: [...cargo], pay };
  let remaining = maxCrates;
  const clamped: CargoLine[] = [];
  for (const line of cargo) {
    if (remaining <= 0) break;
    const count = Math.min(line.count, remaining);
    clamped.push({ ...line, count });
    remaining -= count;
  }
  const scaledPay = Math.max(0, Math.round((pay * maxCrates) / units));
  return { cargo: clamped, pay: scaledPay };
}

/**
 * D6: `pay` must fall within `priceBands[cargoClass].{min,max}` per unit per distance unit,
 * inclusive, scaled by total cargo units and path distance (`shortestPath`, §2.3). Returns a
 * reason string on failure, including for a destination no chain of routes reaches.
 */
export function checkPriceBand(
  ctx: Pick<StepCtx, "content" | "config">,
  fromPortId: PortDefId,
  toPortId: PortDefId,
  cargo: readonly CargoLine[],
  pay: number,
): string | null {
  if (!Number.isInteger(pay) || pay < 0) return "pay must be a nonnegative integer";
  if (cargo.length === 0) return "cargo must have at least one line";
  const route = bandRoute(ctx, fromPortId, toPortId);
  if ("reason" in route) return route.reason;
  const { distance } = route;
  const cargoClass = cargoClassOf(ctx, cargo);
  if (cargoClass === undefined) return "cargo lines must share one cargo class";
  const band = ctx.config.commerce.priceBands[cargoClass];
  if (band === undefined) return `no price band for cargo class "${cargoClass}"`;
  const units = totalCargoUnits(cargo);
  const min = Math.round(band.min * distance * units);
  const max = Math.round(band.max * distance * units);
  if (pay < min || pay > max) return `pay ${pay} outside price band [${min}, ${max}]`;
  return null;
}

/**
 * Passengers-and-galaxy §3.4: a fare is banded by `priceBands.passenger` per unit of path
 * distance, doubled for a round trip; luggage adds nothing. Returns a reason string on failure.
 */
export function checkPassageBand(
  ctx: Pick<StepCtx, "content" | "config">,
  fromPortId: PortDefId,
  toPortId: PortDefId,
  roundTrip: boolean,
  pay: number,
): string | null {
  if (!Number.isInteger(pay) || pay < 0) return "pay must be a nonnegative integer";
  const route = bandRoute(ctx, fromPortId, toPortId);
  if ("reason" in route) return route.reason;
  const band = ctx.config.commerce.priceBands.passenger;
  const fareDistance = roundTrip ? route.distance * 2 : route.distance;
  const min = Math.round(band.min * fareDistance);
  const max = Math.round(band.max * fareDistance);
  if (pay < min || pay > max) return `fare ${pay} outside passenger band [${min}, ${max}]`;
  return null;
}

/**
 * Expeditions A2 (§6, plan call 6): an errand's pay is banded by `priceBands.errand` (`errandPay`)
 * over the shortest path to the site and back on the `"all"` graph, since the site is not known
 * until the offer exists. Returns a reason string on failure.
 */
export function checkErrandBand(
  ctx: Pick<ValidateCtx, "content" | "config" | "state">,
  fromPortId: PortDefId,
  siteId: PortDefId,
  pay: number,
): string | null {
  if (!Number.isInteger(pay) || pay < 0) return "pay must be a nonnegative integer";
  if (ctx.content.ports[fromPortId] === undefined) return `unknown port "${fromPortId}"`;
  if (!isSite(ctx.content, siteId)) return `"${siteId}" is not a landing site`;
  const graph = portGraph(ctx.content, ctx.state, "all");
  const out = shortestPath(graph, fromPortId, siteId);
  const back = shortestPath(graph, siteId, fromPortId);
  if (out === undefined || back === undefined) {
    return `no route from "${fromPortId}" to "${siteId}" and back`;
  }
  const { min, max } = errandPay(ctx.config, out.distance + back.distance, "low");
  if (pay < min || pay > max) return `pay ${pay} outside errand band [${min}, ${max}]`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Accept: spawn manifest, raise cargoToLoad
// ---------------------------------------------------------------------------------------------

function warehouseStoreKey(port: PortDef): ExternalStoreDef["key"] {
  return (
    (port.externalStores.find((s) => s.kind === "warehouse") ?? port.externalStores[0])?.key ?? ""
  );
}

/** A `cargoStowage`-tagged zone on the ship's deck (`shipDeckId`). */
export function cargoStowageZoneKey(ctx: Pick<StepCtx, "content" | "state">): string | undefined {
  const deck = ctx.content.decks[shipDeckId(ctx.state)];
  return deck?.zones.find((z) => z.tags.includes("cargoStowage"))?.key;
}

type Cause = Pick<EventDraft, "causeIds" | "source">;

/** The unattributed system cause `acceptJob` has always used. */
const SYSTEM_CAUSE: Cause = { causeIds: [], source: "system" };

/**
 * Create one item at `location`, a freight item of a job when `freight` names it (owner:
 * commerce), with no work attached. The "kernel spawn path": allocate-and-insert directly, the
 * same pattern `scenarioSpawn`'s `apply()` uses. Staging an offer (§offered-freight) stops here;
 * `spawnCargoItem` also opens the load work, and `spawnAtBoundary` spawns store items this way.
 */
export function spawnItem(
  ctx: ApplyCtx,
  def: { readonly id: ItemDefId },
  count: number,
  stacking: "unique" | "stackable",
  location: PhysicalLocation,
  cause: Cause,
  freight: Pick<Item, "jobId">,
): ItemId {
  const id = allocateId(ctx.state, "item");
  const item: Item =
    stacking === "unique"
      ? { id, defId: def.id, stacking: "unique", location, condition: 1, ...freight }
      : { id, defId: def.id, stacking: "stack", location, count, reserved: 0, ...freight };
  ctx.state.items[id] = item;
  ctx.caches.dirty.inventory = true;
  ctx.emit({
    type: "entitySpawned",
    subjectIds: [id],
    ...cause,
    payload: { entityId: id, defId: def.id },
  });
  return id;
}

type CargoProblemDraft = {
  [K in "cargoToLoad" | "cargoToUnload"]: Pick<ProblemOfKind<K>, "kind" | "payload">;
}["cargoToLoad" | "cargoToUnload"];

/** Open a public, routine `cargoToLoad`/`cargoToUnload` problem at `portId` (owner: commerce). */
function openCargoProblem(
  ctx: ApplyCtx,
  draft: CargoProblemDraft,
  dedupeKey: string,
  portId: PortDefId,
): void {
  const problemId = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[problemId] = {
    id: problemId,
    ...draft,
    owner: "commerce",
    visibility: "public",
    dedupeKey,
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "port", portId },
  };
}

/** Open the `cargoToLoad` problem for one freight item of an accepted job (owner: commerce). */
function raiseLoadProblem(
  ctx: ApplyCtx,
  job: Pick<Job, "id" | "fromPortId">,
  itemId: ItemId,
  stowageZoneKey: string,
): void {
  openCargoProblem(
    ctx,
    { kind: "cargoToLoad", payload: { jobId: job.id, itemId, stowageZoneKey } },
    `cargoToLoad:${job.id}:${itemId}`,
    job.fromPortId,
  );
}

/**
 * Spawn one manifest item at `location` and open its `cargoToLoad` problem. Shared by
 * `acceptJob` (ports without a dock) and `spawnAtBoundary`'s `jobManifest` location, so freight
 * added to an already-accepted job after acceptance loads the same way.
 */
export function spawnCargoItem(
  ctx: ApplyCtx,
  job: Pick<Job, "id" | "fromPortId">,
  def: { readonly id: ItemDefId },
  count: number,
  stacking: "unique" | "stackable",
  location: PhysicalLocation,
  stowageZoneKey: string,
  /** Event attribution; defaults to the unattributed system cause `acceptJob` has always used. */
  cause: Cause = SYSTEM_CAUSE,
): ItemId {
  const id = spawnItem(ctx, def, count, stacking, location, cause, { jobId: job.id });
  raiseLoadProblem(ctx, job, id, stowageZoneKey);
  return id;
}

/**
 * §offered-freight: the staging area's tiles with the free ones first (no item lying there), so
 * several crates spread out before any two share a tile.
 */
export function stagingTilesFreeFirst(
  ctx: Pick<StepCtx, "state">,
  berth: BerthedDock,
): TileCoord[] {
  const tiles = dockAreaTiles(berth, "freightStaging");
  const taken = new Set<string>();
  for (const item of Object.values(ctx.state.items)) {
    if (item.location.kind !== "onDeck") continue;
    taken.add(`${Math.floor(item.location.x)},${Math.floor(item.location.y)}`);
  }
  const free = tiles.filter((t) => !taken.has(`${t.x},${t.y}`));
  return [...free, ...tiles.filter((t) => taken.has(`${t.x},${t.y}`))];
}

/**
 * Where `count` new crates of a job leaving `fromPortId` appear: on the staging area of the
 * origin's dock when it is alongside (§offered-freight), else in the origin's warehouse store.
 */
export function freightSpawnLocations(
  ctx: Pick<StepCtx, "state" | "content" | "defs">,
  fromPortId: PortDefId,
  count: number,
): PhysicalLocation[] {
  const berth = dockAlongsideAt(ctx.content, ctx.state, fromPortId);
  const presence = ctx.state.deck.dock;
  const tiles = berth === undefined ? [] : stagingTilesFreeFirst(ctx, berth);
  if (berth === undefined || presence === undefined || tiles.length === 0) {
    const store = portStoreLocation(ctx.defs.port(fromPortId));
    return Array.from({ length: count }, () => store);
  }
  return Array.from({ length: count }, (_, i) => {
    const tile = tiles[i % tiles.length] as TileCoord;
    return { kind: "onDeck", deckId: presence.deckId, x: tile.x + 0.5, y: tile.y + 0.5 };
  });
}

/**
 * §offered-freight: where an offered job's crates belong right now: staged on its origin's dock
 * while that dock is alongside and the offer can still be taken there (`docking` or `docked`);
 * nowhere otherwise. Undefined for anything but an open offer.
 */
export function offerStagingDock(
  ctx: Pick<StepCtx, "state" | "content">,
  job: Readonly<Job>,
): BerthedDock | undefined {
  if (job.status !== "offered") return undefined;
  const stage = ctx.state.travel.stage;
  if (stage !== "docking" && stage !== "docked") return undefined;
  const berth = dockAlongsideAt(ctx.content, ctx.state, job.fromPortId);
  // A hand-built dock with no staging area stages nothing; acceptance then uses the store.
  return berth !== undefined && dockAreaTiles(berth, "freightStaging").length > 0
    ? berth
    : undefined;
}

/**
 * §offered-freight: stage an offer's freight on the origin's staging area, one crate per unit,
 * owned by nobody: the job stays `offered`, so no work is raised. Records the crates on the job.
 */
export function stageOfferedFreight(ctx: ApplyCtx, job: Job, cause: Cause = SYSTEM_CAUSE): void {
  if (job.cargoItemIds.length > 0) return;
  const units = totalCargoUnits(job.cargo);
  if (units === 0) return;
  const locations = freightSpawnLocations(ctx, job.fromPortId, units);
  const ids: ItemId[] = [];
  for (const line of job.cargo) {
    const def = ctx.defs.item(line.itemDefId);
    for (let i = 0; i < line.count; i++) {
      const location = locations[ids.length] as PhysicalLocation;
      ids.push(spawnItem(ctx, def, 1, def.stacking, location, cause, { jobId: job.id }));
    }
  }
  job.cargoItemIds = ids;
  ctx.emit({
    ...cause,
    type: "freightStaged",
    subjectIds: [job.id, ...ids],
    locationRef: { kind: "port", portId: job.fromPortId },
    payload: { jobId: job.id, portId: job.fromPortId, count: ids.length },
  });
}

/**
 * Every crew member (not passengers) is told where the freight they are about to load lies, as
 * a report, the way the market briefs them on a purchase: the planner can then cost the walk out
 * to the staging area before anyone has looked.
 */
function briefCrew(ctx: ApplyCtx, itemIds: readonly ItemId[]): void {
  const source = { tick: ctx.tick, evidence: "report", certainty: "reported" } as const;
  for (const actor of Object.values(ctx.state.actors)) {
    if (!actor.crew || actor.passenger === true) continue;
    // Their first look's familiarity brief covers every on-deck item, the staged crates included;
    // a fact written here first would stop that brief, and they would never learn the stores.
    if (awaitsFamiliarityBrief(actor)) continue;
    for (const itemId of itemIds) {
      const item = ctx.state.items[itemId];
      if (item === undefined) continue;
      writeFact(
        actor,
        itemId,
        "itemLocation",
        { location: item.location },
        {
          ...source,
          sourceId: actor.id,
        },
      );
    }
  }
}

/**
 * Accept a job's manifest, one item per cargo unit (owner feedback 2026-09-30: loading must read
 * as one crate at a time). §loading: at a port with a dock the crates are already staged (staged
 * now if the offer was taken before the sweep got to it), and accepting opens their `cargoToLoad`
 * work and briefs the crew where they lie. Without a dock the manifest spawns into the origin's
 * warehouse store, loaded through the transfer tiles as before.
 */
export function acceptJob(ctx: ApplyCtx, job: Job): ItemId[] {
  const stowageZoneKey = cargoStowageZoneKey(ctx) ?? "cargoHold";
  const dock = dockAlongsideAt(ctx.content, ctx.state, job.fromPortId);
  if (dock !== undefined && dockAreaTiles(dock, "freightStaging").length > 0) {
    stageOfferedFreight(ctx, job);
  }
  if (job.cargoItemIds.length > 0) {
    for (const itemId of job.cargoItemIds) raiseLoadProblem(ctx, job, itemId, stowageZoneKey);
    briefCrew(ctx, job.cargoItemIds);
    return [...job.cargoItemIds];
  }
  const location = portStoreLocation(ctx.defs.port(job.fromPortId));
  const spawnedIds: ItemId[] = [];
  for (const line of job.cargo) {
    const def = ctx.defs.item(line.itemDefId);
    for (let i = 0; i < line.count; i++) {
      spawnedIds.push(spawnCargoItem(ctx, job, def, 1, def.stacking, location, stowageZoneKey));
    }
  }
  return spawnedIds;
}

/**
 * Raise one `cargoToUnload` problem per manifest item (owner: commerce), called on arrival at
 * the job's destination (see `commerce.ts` `sweepJobs`). Deduped like `acceptJob`. A passage
 * put off early (`passage.ts`) unloads its luggage at whatever port the passenger leaves from:
 * `portId` names it and `itemIds` narrows the manifest to what is aboard; such a problem gets
 * its own dedupe key, since the job's regular unload at `toPortId` may already be on record.
 */
export function raiseUnloadProblems(
  ctx: ApplyCtx,
  job: Job,
  portId: PortDefId = job.toPortId,
  itemIds: readonly ItemId[] = job.cargoItemIds,
): void {
  const storeKey = warehouseStoreKey(ctx.defs.port(portId));
  for (const itemId of itemIds) {
    const dedupeKey =
      portId === job.toPortId
        ? `cargoToUnload:${job.id}:${itemId}`
        : `cargoToUnload:${job.id}:${itemId}:${portId}`;
    if (Object.values(ctx.state.work.problems).some((p) => p.dedupeKey === dedupeKey)) continue;
    openCargoProblem(
      ctx,
      { kind: "cargoToUnload", payload: { jobId: job.id, itemId, portId, storeKey } },
      dedupeKey,
      portId,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Delivery and payment
// ---------------------------------------------------------------------------------------------

type CustodyState = Pick<ReadonlyWorldState, "items" | "deck">;

/**
 * Pure: is this item in `portId`'s custody? In one of its stores, or (§offered-freight) set down in
 * the delivery bay of its dock while that dock is alongside: custody is checked in the bay.
 */
function inPortCustody(
  state: CustodyState,
  content: Pick<StepCtx["content"], "docks" | "decks">,
  itemId: ItemId,
  portId: PortDefId,
): boolean {
  const location = state.items[itemId]?.location;
  if (location === undefined) return false;
  if (location.kind === "inExternalStore") return location.portId === portId;
  return (
    dockAlongsideAt(content, state, portId) !== undefined &&
    isInDockArea(content, state, location, "deliveryBay")
  );
}

/**
 * Pure: every manifest item is delivered at the job's destination: in one of its stores, or in
 * the delivery bay of its dock while alongside (§delivery-and-pay).
 */
export function deliveryComplete(
  state: CustodyState,
  content: Pick<StepCtx["content"], "docks" | "decks">,
  job: Pick<Job, "cargoItemIds" | "toPortId">,
): boolean {
  if (job.cargoItemIds.length === 0) return false;
  return job.cargoItemIds.every((itemId) => inPortCustody(state, content, itemId, job.toPortId));
}

/**
 * Pure: what a job must have done to earn its pay. Freight: every manifest item delivered
 * (`deliveryComplete`). A passage (§3.4): the passenger's journey ended `completed`, plus the
 * luggage delivered when there is any. An errand (expeditions A2, §6) without a passage: what
 * `errandFulfilled` says; one carrying its captive is paid as the passage is.
 */
export function jobFulfilled(
  state: CustodyState & Pick<ReadonlyWorldState, "travel">,
  content: Pick<StepCtx["content"], "docks" | "decks">,
  job: Pick<Job, "cargoItemIds" | "toPortId" | "passage" | "errand">,
): boolean {
  if (job.passage === undefined) {
    return job.errand === undefined
      ? deliveryComplete(state, content, job)
      : errandFulfilled(state, content, job);
  }
  if (job.passage.endReason !== "completed") return false;
  return job.cargoItemIds.length === 0 || deliveryComplete(state, content, job);
}

/** Pay a delivered job exactly once, guarded by `paymentTransactionId` (SD §17.3). */
export function payJobIfDue(ctx: ApplyCtx, job: Job): void {
  if (job.paymentTransactionId !== undefined) return;
  if (job.status !== "accepted" && job.status !== "inTransit" && job.status !== "delivered") return;
  if (!jobFulfilled(ctx.state, ctx.content, job)) return;
  const txId: TransactionId = allocateId(ctx.state, "transaction");
  ctx.state.money.balance += job.pay;
  ctx.state.money.transactions[txId] = {
    id: txId,
    tick: ctx.tick,
    amount: job.pay,
    reason: "jobPayment",
    jobId: job.id,
  };
  job.paymentTransactionId = txId;
  job.status = "paid";
  ctx.emit({
    type: "contractCompleted",
    subjectIds: [job.id],
    causeIds: [],
    source: "sim",
    payload: { jobId: job.id },
  });
  ctx.emit({
    type: "paymentMade",
    subjectIds: [job.id],
    causeIds: [],
    source: "sim",
    payload: { transactionId: txId, amount: job.pay, jobId: job.id },
  });
}

/** Expire stale offers (`config.commerce.jobOfferTtlDays`). */
export function expireStaleOffers(ctx: ApplyCtx): void {
  for (const job of Object.values(ctx.state.jobs)) {
    if (job.status === "offered" && ctx.tick > job.expiresAtTick) {
      job.status = "expired";
      job.closedTick = ctx.tick;
      ctx.emit({
        type: "jobExpired",
        subjectIds: [job.id],
        causeIds: [],
        source: "sim",
        payload: { jobId: job.id },
      });
      // §dock-hand-errands: its crates go back in by way of a dock hand (`dock-hands.ts`, the same
      // tick).
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Offer cards (§offer-cards)
// ---------------------------------------------------------------------------------------------

/**
 * Params for the offer card's `job.offer` template (`@crew/content` renders them): the person,
 * the route, the cargo kind, the urgency and the pitch (its prose, or its key when it has none).
 * §cards-never-mention-pay: pay is deliberately absent, so no card can print it.
 */
function offerPromptParams(job: Readonly<Job>): Record<string, string> {
  const person = job.issuerPerson;
  const firstLine = job.cargo[0];
  const pitch = job.pitch.prose;
  return {
    issuer: job.issuer,
    name: person.name,
    role: person.role,
    ...(person.org === undefined ? {} : { org: person.org }),
    from: job.fromPortId,
    to: job.toPortId,
    ...(firstLine === undefined ? {} : { cargo: firstLine.itemDefId }),
    urgency: job.urgency,
    ...(pitch === undefined || pitch.trim() === "" ? { pitchKey: job.pitch.key } : { pitch }),
    // Passengers §6: the offer card says it is a person travelling, and whether they come back.
    ...(job.passage === undefined
      ? {}
      : { passenger: "true", roundTrip: job.passage.roundTrip ? "true" : "false" }),
    // Expeditions A2 (§6): an errand says who or what is fetched, from which site, and how.
    ...(job.errand === undefined
      ? {}
      : {
          errand: job.errand.kind,
          target: job.errand.targetName,
          site: job.errand.siteId,
          wants: job.errand.wants,
        }),
  };
}

/** Whether the ship is docked at the port the job departs from. */
export function dockedAtOrigin(
  state: Pick<ReadonlyWorldState, "travel">,
  job: { readonly fromPortId: PortDefId },
): boolean {
  const travel = state.travel;
  return travel.stage === "docked" && travel.portId === job.fromPortId;
}

/**
 * Build the offer's decision card: "Take the job" accepts and sets course for the destination,
 * "Pass" declines. The one place a job card is built. §offer-cards: offers are only surfaced
 * while docked at their origin, and the card is held until the captain meets the issuer
 * (`core/delivery.ts`), unless the issuer is aboard already.
 */
export function surfaceOfferCard(ctx: ApplyCtx, job: Job): DecisionId {
  // Expeditions A2 call 3: an errand's course is the site; its `toPortId` is home, where the ship
  // is now, which `setCourse` would refuse. Both sides validate before either applies, so the site
  // is still known (the job still `offered`) when `setCourse` checks the route.
  const destinationPortId = job.errand === undefined ? job.toPortId : job.errand.siteId;
  const decisionId: DecisionId = allocateId(ctx.state, "decision");
  ctx.state.decisions.records[decisionId] = {
    id: decisionId,
    origin: job.origin === "narrator" ? "narrator" : "policy",
    perspectiveActorId: commandActor(ctx.state),
    prompt: { key: "job.offer", params: offerPromptParams(job) },
    // Integration 2: accepting also sets course for the job's destination. `setCourse`
    // applies after `acceptContract` in the same resolution, sees the freshly raised
    // `cargoToLoad` problems and holds departure until the freight is aboard.
    left: {
      label: { key: "job.offer.accept", params: {} },
      commands: [
        { kind: "acceptContract", payload: { jobId: job.id } },
        { kind: "setCourse", payload: { destinationPortId } },
      ],
      aftermath: { key: "job.accept.aftermath", params: {} },
    },
    right: {
      label: { key: "job.offer.decline", params: {} },
      commands: [{ kind: "declineJob", payload: { jobId: job.id } }],
      aftermath: { key: "job.decline.aftermath", params: {} },
    },
    status: "pending",
    createdTick: ctx.tick,
    jobId: job.id,
  };
  // §offers-in-person: the issuer is one of the port's people, so the card waits to be delivered in
  // person.
  queueOrHold(ctx, decisionId, job.issuerPerson.name);
  return decisionId;
}
