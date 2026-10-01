/**
 * Job lifecycle (SD §17.3, PLAN §6 W6 item 3): `offered -> accepted -> inTransit -> delivered ->
 * paid | declined | expired | failed`. Accepting spawns the manifest into the origin port's
 * store and raises `cargoToLoad` problems; a per-tick sweep here pays a job exactly once
 * (`Job.paymentTransactionId` guard) once every line is confirmed in the destination store.
 */
import type { ApplyCtx } from "../../core/commands";
import { allocateId } from "../../core/ids";
import type { PhysicalLocation } from "../../core/types/common";
import type { CargoClass, ExternalStoreDef, PortDef } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type { ItemDefId, ItemId, PortDefId, ProblemId, TransactionId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { CargoLine, Job, JobIssuer } from "../../core/types/travel";
import { portStoreLocation } from "../travel/travel";

// ---------------------------------------------------------------------------------------------
// Issuers (D25)
// ---------------------------------------------------------------------------------------------

/** Role given to an issuer known only by a bare name (old saves, string-issuer drafts). */
export const LEGACY_ISSUER_ROLE = "shipper";

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

export function routeDistance(port: PortDef, toPortId: PortDefId): number | undefined {
  return port.routes.find((r) => r.toPortId === toPortId)?.distance;
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
export function totalCargoUnits(cargo: readonly CargoLine[]): number {
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
 * inclusive, scaled by total cargo units and route distance. Returns a reason string on failure.
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
  const fromPort = ctx.content.ports[fromPortId];
  if (fromPort === undefined) return `unknown port "${fromPortId}"`;
  if (ctx.content.ports[toPortId] === undefined) return `unknown port "${toPortId}"`;
  const distance = routeDistance(fromPort, toPortId);
  if (distance === undefined) return `no route from "${fromPortId}" to "${toPortId}"`;
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

// ---------------------------------------------------------------------------------------------
// Accept: spawn manifest, raise cargoToLoad
// ---------------------------------------------------------------------------------------------

function warehouseStoreKey(port: PortDef): ExternalStoreDef["key"] {
  return (
    (port.externalStores.find((s) => s.kind === "warehouse") ?? port.externalStores[0])?.key ?? ""
  );
}

/** V1's single ship deck (see `travel.ts` `theDeckId`); a `cargoStowage`-tagged zone on it. */
export function cargoStowageZoneKey(ctx: Pick<StepCtx, "content">): string | undefined {
  const [deck] = Object.values(ctx.content.decks);
  return deck?.zones.find((z) => z.tags.includes("cargoStowage"))?.key;
}

/**
 * Spawn one manifest item into a job's origin-port store and open its `cargoToLoad` problem
 * (owner: commerce). The "kernel spawn path": allocate-and-insert directly, the same pattern
 * `scenarioSpawn`'s `apply()` uses; there is no separate boundary-spawn command for commerce to
 * call into for a job's own manifest. Shared by `acceptJob` and `spawnAtBoundary`'s `jobManifest`
 * location, so freight added to an already-accepted job after acceptance loads the same way.
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
  cause: Pick<EventDraft, "causeIds" | "source"> = { causeIds: [], source: "system" },
): ItemId {
  const id = allocateId(ctx.state, "item");
  const item: Item =
    stacking === "unique"
      ? { id, defId: def.id, stacking: "unique", location, condition: 1, jobId: job.id }
      : { id, defId: def.id, stacking: "stack", location, count, reserved: 0, jobId: job.id };
  ctx.state.items[id] = item;
  ctx.caches.dirty.inventory = true;
  ctx.emit({
    type: "entitySpawned",
    subjectIds: [id],
    ...cause,
    payload: { entityId: id, defId: def.id },
  });
  const problemId = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[problemId] = {
    id: problemId,
    kind: "cargoToLoad",
    payload: { jobId: job.id, itemId: id, stowageZoneKey },
    owner: "commerce",
    visibility: "public",
    dedupeKey: `cargoToLoad:${job.id}:${id}`,
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "port", portId: job.fromPortId },
  };
  return id;
}

/**
 * Spawn a job's whole manifest into the origin port's store on acceptance, one item per cargo
 * unit (owner feedback 2026-09-30: loading must read as one crate at a time, not one stack of N
 * appearing all at once). Item defs may still be `"stackable"` for other purposes (e.g. rations in
 * ship's stores); a job's own manifest items are simply spawned with `count: 1` each here.
 */
export function acceptJob(ctx: ApplyCtx, job: Job): ItemId[] {
  const fromPort = ctx.defs.port(job.fromPortId);
  const location = portStoreLocation(fromPort);
  const stowageZoneKey = cargoStowageZoneKey(ctx) ?? "cargoHold";
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
 * the job's destination (see `commerce.ts` `sweepJobs`). Deduped like `acceptJob`.
 */
export function raiseUnloadProblems(ctx: ApplyCtx, job: Job): void {
  const toPort = ctx.defs.port(job.toPortId);
  const storeKey = warehouseStoreKey(toPort);
  for (const itemId of job.cargoItemIds) {
    const dedupeKey = `cargoToUnload:${job.id}:${itemId}`;
    if (Object.values(ctx.state.work.problems).some((p) => p.dedupeKey === dedupeKey)) continue;
    const problemId = allocateId(ctx.state, "problem") as ProblemId;
    ctx.state.work.problems[problemId] = {
      id: problemId,
      kind: "cargoToUnload",
      payload: { jobId: job.id, itemId, portId: job.toPortId, storeKey },
      owner: "commerce",
      visibility: "public",
      dedupeKey,
      status: "open",
      createdTick: ctx.tick,
      revision: 1,
      baseUrgency: "routineObligation",
      location: { kind: "port", portId: job.toPortId },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Delivery and payment
// ---------------------------------------------------------------------------------------------

/** Pure: every manifest item is physically in an external store at the job's destination port. */
export function deliveryComplete(
  state: Pick<ReadonlyWorldState, "items">,
  job: Pick<Job, "cargoItemIds" | "toPortId">,
): boolean {
  if (job.cargoItemIds.length === 0) return false;
  return job.cargoItemIds.every((itemId) => {
    const item = state.items[itemId];
    return (
      item !== undefined &&
      item.location.kind === "inExternalStore" &&
      item.location.portId === job.toPortId
    );
  });
}

/** Pay a delivered job exactly once, guarded by `paymentTransactionId` (SD §17.3). */
export function payJobIfDue(ctx: ApplyCtx, job: Job): void {
  if (job.status === "paid" || job.paymentTransactionId !== undefined) return;
  if (job.status !== "accepted" && job.status !== "inTransit" && job.status !== "delivered") return;
  if (!deliveryComplete(ctx.state, job)) return;
  job.status = "delivered";
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

/** Expire stale offers (`config.commerce.jobOfferTtlSeconds`). */
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
    }
  }
}
