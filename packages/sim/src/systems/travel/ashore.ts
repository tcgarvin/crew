/**
 * Dockside (D61): people and things on the dock alongside, as travel sees them when the ship
 * leaves.
 *
 * - Departure prep keeps the ramps down while anyone is on the dock, or aboard and walking onto
 *   it (`peopleAshore`), and calls them aboard: a `comeAboard` walk to the top of the nearest
 *   ramp (`callAboard`). A passenger walking off (`disembarking`) is not called back; commerce
 *   owns that walk.
 * - Nobody holds a departure forever. Someone on the dock who cannot walk back (not available,
 *   not crew, or their walk failed and is backing off) is brought aboard by the dock crew at
 *   once, and once the call has run `travel.recallAboardSeconds` everyone still on the dock is
 *   (`bringAboardStragglers`). Both emit `broughtAboard`, which the ticker shows.
 * - At the end of `undocking` the dock is cleared before it detaches (`clearDock`): anything
 *   still on it is left at the port's warehouse (`leftOnDock`), except the ship's own gear (D65:
 *   a hand truck dropped there mid-trip), which the dock crew hand up the cargo ramp
 *   (`gearBroughtAboard`); anyone still on it (prep makes that impossible; this is the last
 *   guard) is brought aboard.
 * - D63: a buyer out through the gate on a market errand (`throughGate`, off ship) counts as
 *   ashore: the ramps stay down for them and the call waits for them to come back on their own;
 *   only an overdue call (or the last guard) fetches them, ending the errand at the gate.
 */
import { configTicks } from "../../core/clock";
import { isDockPoint, isOnDock } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type { DoorId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import { dockRamps, rampLanding, rampTop } from "../spatial/dock";
import { deckGeometry } from "../spatial/geometry";
import { centre } from "../spatial/movement";
import { releaseReservations } from "../spatial/reservations";
import { backoffRef, isBackingOff, isOutThroughGate } from "../work/activity";
import { abortActivity } from "../work/execute";
import { truckCapacity } from "../work/truck";
import type { InFlight } from "./travel";

type Ctx = StepCtx;

const COME_ABOARD_REF = backoffRef.personal("comeAboard");

/** Is this actor walking a route that ends on the dock? */
function headedAshore(ctx: Ctx, actor: Actor): boolean {
  const movement = actor.movement;
  if (movement.kind !== "moving") return false;
  const end = movement.path[movement.path.length - 1];
  return end !== undefined && isDockPoint(ctx.content, ctx.state, end.x, end.y);
}

/** Is this actor walking a route that ends aboard? */
function headedAboard(ctx: Ctx, actor: Actor): boolean {
  const movement = actor.movement;
  if (movement.kind !== "moving") return false;
  const end = movement.path[movement.path.length - 1];
  return end !== undefined && !isDockPoint(ctx.content, ctx.state, end.x, end.y);
}

function onDock(ctx: Ctx, actor: Actor): boolean {
  return isOnDock(ctx.content, ctx.state, actor.location);
}

/**
 * Everyone the ramps must stay down for, in id order: on the dock, aboard and walking onto it,
 * or (D63) out through the gate on a market errand. Empty with no dock alongside.
 */
export function peopleAshore(ctx: Ctx): Actor[] {
  if (ctx.state.deck.dock === undefined) return [];
  return Object.values(ctx.state.actors)
    .filter((actor) => onDock(ctx, actor) || headedAshore(ctx, actor) || isOutThroughGate(actor))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** Can this actor walk back aboard on their own right now? */
function canWalkAboard(ctx: Ctx, actor: Actor): boolean {
  return (
    actor.crew &&
    actor.availability === "available" &&
    !isBackingOff(actor.workBackoff, COME_ABOARD_REF, ctx.tick)
  );
}

/**
 * The top of the ramp nearest the actor (by its landing), preferring one that is not jammed:
 * where a `comeAboard` walk ends and where the dock crew set someone down.
 */
function nearestRampTop(ctx: Ctx, actor: Actor): TileCoord {
  const presence = ctx.state.deck.dock;
  const location = actor.location;
  if (presence === undefined || location.kind !== "onDeck") {
    throw new Error(`nearestRampTop: ${actor.id} is not on a deck with a dock alongside`);
  }
  const geometry = deckGeometry(ctx.caches, presence.deckId);
  let best: { rampId: DoorId; score: number } | undefined;
  for (const rampId of dockRamps(geometry)) {
    const landing = rampLanding(geometry, rampId);
    const dx = landing.x + 0.5 - location.x;
    const dy = landing.y + 0.5 - location.y;
    const jammed = ctx.state.doors[rampId]?.physicalState === "jammed";
    const score = dx * dx + dy * dy + (jammed ? 1e9 : 0);
    if (best === undefined || score < best.score) best = { rampId, score };
  }
  if (best === undefined) throw new Error(`Dock "${presence.dockId}" has no ramp landing`);
  return rampTop(geometry, best.rampId);
}

/**
 * Give everyone ashore who can walk, and is not already on their way up, a `comeAboard` walk to
 * the nearest ramp top. Retried every tick: the planner may overwrite a pending intent on the
 * tick it runs, and a `comeAboard` already under way is left alone by the work system.
 */
function callAboard(ctx: Ctx, ashore: readonly Actor[]): void {
  for (const actor of ashore) {
    if (actor.disembarking === true || headedAboard(ctx, actor) || !canWalkAboard(ctx, actor)) {
      continue;
    }
    const tile = nearestRampTop(ctx, actor);
    actor.pendingIntent = {
      kind: "personal",
      activity: "comeAboard",
      tile,
      urgency: "essentialOperation",
      trace: { candidates: 0, chosenReason: "called aboard for departure", rejected: [] },
    };
  }
}

/**
 * The dock crew carry or walk someone up the nearest ramp: they stand at its top, idle. A buyer
 * out through the gate (D63) is fetched back first: their errand ends at the gate.
 */
function bringAboard(ctx: Ctx, actor: Actor, portId: PortDefId): void {
  if (isOutThroughGate(actor)) abortActivity(ctx, actor, "interrupted");
  const location = actor.location;
  if (location.kind !== "onDeck") {
    throw new Error(`bringAboard: ${actor.id} is not on the map (${location.kind})`);
  }
  const tile = nearestRampTop(ctx, actor);
  releaseReservations(ctx.caches, actor.id);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: location.deckId, ...centre(tile) };
  // After the move, so anything they were hauling is set down aboard, not left on the dock.
  abortActivity(ctx, actor, "interrupted");
  if (actor.pendingIntent !== undefined) {
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete actor.pendingIntent;
  }
  ctx.emit({
    type: "broughtAboard",
    subjectIds: [actor.id],
    locationRef: { kind: "port", portId },
    causeIds: [],
    source: "sim",
    payload: { actorId: actor.id, name: actor.name, portId },
  });
}

/**
 * One tick of departure prep's call with people ashore (`ashore` non-empty): start or keep the
 * call's clock, bring aboard whoever cannot walk (everyone still on the dock once the clock has
 * run out), and call the rest. A passenger walking off is never carried back.
 */
export function recallAshore(ctx: Ctx, travel: InFlight, ashore: readonly Actor[]): void {
  travel.recallSinceTick ??= ctx.tick;
  const limit = configTicks(ctx.config, ctx.config.travel.recallAboardSeconds);
  const overdue = ctx.tick - travel.recallSinceTick >= limit;
  for (const actor of ashore) {
    if (actor.disembarking === true) continue;
    // D63: a buyer out through the gate comes back on their own; only an overdue call fetches them.
    if (isOutThroughGate(actor)) {
      if (overdue) bringAboard(ctx, actor, travel.fromPortId);
      continue;
    }
    if (!onDock(ctx, actor)) continue;
    if (overdue || !canWalkAboard(ctx, actor)) bringAboard(ctx, actor, travel.fromPortId);
  }
  callAboard(ctx, ashore);
}

/** Nobody is ashore any more: the next call (if anyone strays) starts a fresh clock. */
export function endRecall(travel: InFlight): void {
  if (travel.recallSinceTick === undefined) return;
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete travel.recallSinceTick;
}

/** D65: the ship's own hand truck (equipment, not freight: no job owns it). */
function isShipsGear(ctx: Ctx, item: Item): boolean {
  return item.jobId === undefined && truckCapacity(ctx, item) > 0;
}

/**
 * D65: the ship's gear left lying on the dock (a hand truck set down by someone stopped mid-trip)
 * is handed up the cargo ramp by the dock crew, as people are, and set down at its top.
 */
function handAboard(ctx: Ctx, item: Item, portId: PortDefId): void {
  const location = item.location;
  if (location.kind !== "onDeck") return;
  const top = ctx.content.decks[location.deckId]?.docking.cargoTransferTiles[0];
  if (top === undefined)
    throw new Error(`handAboard: deck "${location.deckId}" has no cargo ramp top`);
  item.location = { kind: "onDeck", deckId: location.deckId, ...centre(top) };
  ctx.dirty.inventory = true;
  ctx.emit({
    type: "gearBroughtAboard",
    subjectIds: [item.id],
    locationRef: { kind: "port", portId },
    causeIds: [],
    source: "sim",
    payload: { itemId: item.id, portId },
  });
}

/**
 * Clear the dock before it detaches at the end of `undocking`: anyone still on it is brought
 * aboard, and anything still on it stays at the port, in `store` (its warehouse).
 */
export function clearDock(ctx: Ctx, portId: PortDefId, store: PhysicalLocation): void {
  if (ctx.state.deck.dock === undefined) return;
  for (const actor of Object.values(ctx.state.actors)) {
    if (onDock(ctx, actor) || isOutThroughGate(actor)) bringAboard(ctx, actor, portId);
  }
  for (const item of Object.values(ctx.state.items)) {
    if (!isOnDock(ctx.content, ctx.state, item.location)) continue;
    if (isShipsGear(ctx, item)) {
      handAboard(ctx, item, portId);
      continue;
    }
    item.location = store;
    ctx.dirty.inventory = true;
    ctx.emit({
      type: "leftOnDock",
      subjectIds: [item.id],
      locationRef: { kind: "port", portId },
      causeIds: [],
      source: "sim",
      payload: { itemId: item.id, portId },
    });
  }
}
