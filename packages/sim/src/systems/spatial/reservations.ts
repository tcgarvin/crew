/**
 * Exclusive interaction positions (SD §6.4, §7.4). Only an actor's route *destination* needs a
 * reservation; passing through an interaction tile does not.
 *
 * W3 decision: the contract has no state slot for reservations, so they live in
 * `caches.nav.reservations` and are rebuilt from state on restore: first every stationary actor
 * standing on an interaction tile, then moving actors whose route ends on one (in `state.actors`
 * order, up to capacity), skipping actors that are waiting for the position (`blockedSinceTick`
 * set with no `doorId`). A contested position can therefore change hands across a restore; that
 * is accepted (D4: determinism is not a goal).
 */
import type { TileCoord } from "../../core/types/common";
import type { ActorId, DeckDefId } from "../../core/types/ids";
import type { DeckGeometry, NavInteractionPosition } from "../../core/types/nav";
import type { DerivedCaches, ReadonlyWorldState } from "../../core/types/pipeline";

export function reservationKey(deckId: DeckDefId, tile: TileCoord): string {
  return `${deckId}:${tile.x},${tile.y}`;
}

/** Interaction positions on a tile (usually zero or one). */
export function interactionsAt(
  geometry: DeckGeometry,
  tile: TileCoord,
): readonly NavInteractionPosition[] {
  return geometry.interactionByTile.get(tile.y * geometry.width + tile.x) ?? [];
}

/**
 * How many actors may stand on this tile as a destination; `Infinity` for ordinary floor. Where
 * two positions share a tile, the smaller capacity wins (they share one physical spot).
 */
export function tileCapacity(geometry: DeckGeometry, tile: TileCoord): number {
  const positions = interactionsAt(geometry, tile);
  if (positions.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...positions.map((p) => p.capacity));
}

export function reservationHolders(
  caches: DerivedCaches,
  deckId: DeckDefId,
  tile: TileCoord,
): readonly ActorId[] {
  return caches.nav.reservations[reservationKey(deckId, tile)] ?? [];
}

export function holdsReservation(
  caches: DerivedCaches,
  deckId: DeckDefId,
  tile: TileCoord,
  actorId: ActorId,
): boolean {
  return reservationHolders(caches, deckId, tile).includes(actorId);
}

/**
 * Reserve the interaction position on `tile` for `actorId`. True if the actor now holds it or
 * the tile is not an interaction position; false if it is full. W4 calls this before starting
 * work at a position; `requestMove` calls it for a route's destination.
 */
export function tryReserve(
  caches: DerivedCaches,
  geometry: DeckGeometry,
  tile: TileCoord,
  actorId: ActorId,
): boolean {
  const capacity = tileCapacity(geometry, tile);
  if (capacity === Number.POSITIVE_INFINITY) return true;
  const key = reservationKey(geometry.deckId, tile);
  const holders = caches.nav.reservations[key] ?? [];
  if (holders.includes(actorId)) return true;
  if (holders.length >= capacity) return false;
  caches.nav.reservations[key] = [...holders, actorId];
  return true;
}

/** Drop every reservation `actorId` holds, except on `keep` (if given). */
export function releaseReservations(
  caches: DerivedCaches,
  actorId: ActorId,
  keep?: { readonly deckId: DeckDefId; readonly tile: TileCoord },
): void {
  const keepKey = keep === undefined ? undefined : reservationKey(keep.deckId, keep.tile);
  const table = caches.nav.reservations;
  for (const [key, holders] of Object.entries(table)) {
    if (key === keepKey || !holders.includes(actorId)) continue;
    const rest = holders.filter((id) => id !== actorId);
    if (rest.length === 0) delete table[key];
    else table[key] = rest;
  }
}

export function rebuildReservations(caches: DerivedCaches, state: ReadonlyWorldState): void {
  caches.nav.reservations = {};
  const actors = Object.values(state.actors);
  for (const actor of actors) {
    const location = actor.location;
    if (location.kind !== "onDeck" || actor.movement.kind !== "stationary") continue;
    const geometry = caches.nav.decks[location.deckId];
    if (geometry === undefined) continue;
    const tile = { x: Math.floor(location.x), y: Math.floor(location.y) };
    if (interactionsAt(geometry, tile).length === 0) continue;
    const key = reservationKey(geometry.deckId, tile);
    caches.nav.reservations[key] = [...(caches.nav.reservations[key] ?? []), actor.id];
  }
  for (const actor of actors) {
    const location = actor.location;
    const movement = actor.movement;
    if (location.kind !== "onDeck" || movement.kind !== "moving") continue;
    const waitingForPosition =
      movement.blockedSinceTick !== undefined && movement.doorId === undefined;
    const destination = movement.path[movement.path.length - 1];
    const geometry = caches.nav.decks[location.deckId];
    if (waitingForPosition || destination === undefined || geometry === undefined) continue;
    tryReserve(caches, geometry, destination, actor.id);
  }
}
