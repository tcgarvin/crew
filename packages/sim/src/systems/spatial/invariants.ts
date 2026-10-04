/**
 * Spatial invariants for tests and debugging: on-deck actors stand on walkable floor, a moving
 * actor's x/y equals the position derived from its route, nobody is inside a door aperture
 * unless the door is open, and no interaction position is over capacity. Dockside spike: the nav
 * grid grafts exactly the dock `state.deck.dock` names, its open-ramp set matches the doors, and
 * no on-deck item lies off floor (say, on a dock taken away from under it).
 */
import type { World } from "../../core/types/kernel";
import { dockGraftCurrent, doorBetween, isStaticFloor, rampPassable } from "./geometry";
import { derivedPosition, isStandable } from "./movement";
import { parseReservationKey, tileCapacity } from "./reservations";

export function spatialViolations(world: World): string[] {
  const out: string[] = [];
  const { state, caches } = world;
  if (!dockGraftCurrent(caches, state)) out.push("nav grid does not graft state.deck.dock");
  for (const geometry of Object.values(caches.nav.decks)) {
    for (const nav of geometry.doors.values()) {
      if (nav.placement.kind !== "ramp") continue;
      const door = state.doors[nav.id];
      const passable = door !== undefined && rampPassable(door);
      if (passable !== geometry.openRamps.has(nav.id)) {
        out.push(`open-ramp set is stale for ${nav.id}`);
      }
    }
  }
  for (const item of Object.values(state.items)) {
    const l = item.location;
    if (l.kind !== "onDeck") continue;
    const geometry = caches.nav.decks[l.deckId];
    if (geometry !== undefined && !isStaticFloor(geometry, l.x, l.y)) {
      out.push(`items.${item.id} lies off floor at ${l.x},${l.y}`);
    }
  }
  for (const actor of Object.values(state.actors)) {
    const location = actor.location;
    if (location.kind !== "onDeck") continue;
    const geometry = caches.nav.decks[location.deckId];
    if (geometry === undefined) {
      out.push(`actors.${actor.id} is on unknown deck ${location.deckId}`);
      continue;
    }
    if (!isStandable(geometry, location)) {
      out.push(`actors.${actor.id} stands on non-floor at ${location.x},${location.y}`);
    }
    const movement = actor.movement;
    if (movement.kind !== "moving") continue;
    const derived = derivedPosition(movement);
    if (
      derived === undefined ||
      Math.abs(derived.x - location.x) > 1e-9 ||
      Math.abs(derived.y - location.y) > 1e-9
    ) {
      out.push(`actors.${actor.id} location disagrees with its route`);
    }
    const a = movement.path[movement.segmentIndex];
    const b = movement.path[movement.segmentIndex + 1];
    if (a !== undefined && b !== undefined && movement.segmentDistanceTravelled > 0) {
      const doorId = doorBetween(geometry, a, b);
      const door = doorId === undefined ? undefined : state.doors[doorId];
      if (door !== undefined && door.physicalState !== "open") {
        out.push(`actors.${actor.id} is in the aperture of ${door.physicalState} door ${door.id}`);
      }
    }
  }
  for (const [key, holders] of Object.entries(caches.nav.reservations)) {
    const { deckId, tile } = parseReservationKey(key);
    const geometry = caches.nav.decks[deckId];
    if (geometry === undefined) continue;
    if (holders.length > tileCapacity(geometry, tile)) {
      out.push(`reservation ${key} has ${holders.length} holders`);
    }
  }
  return out;
}
