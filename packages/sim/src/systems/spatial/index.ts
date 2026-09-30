/**
 * Spatial system (W3): deck geometry, pathfinding, movement, doors, interaction reservations.
 * `registerSpatial(registry)` installs the nav cache builder and the phase 2/3 systems.
 */
import type { KernelRegistry } from "../../core/registry";
import { doorsSystem } from "./doors";
import { navCacheBuilder } from "./geometry";
import { movementSystem } from "./movement";
import { navRefreshSystem } from "./topology";

export { doorHasPower, doorWillOpen, doorsSystem, isPowerDomainLive } from "./doors";
export { estimateTravelTicks, knownRoute } from "./estimates";
export {
  compartmentAt,
  deckGeometry,
  doorBetween,
  isWalkable,
  navCacheBuilder,
  rebuildNav,
} from "./geometry";
export { spatialViolations } from "./invariants";
export {
  derivedPosition,
  type InteractionTarget,
  type MoveTarget,
  movementSystem,
  requestMove,
  stopMovement,
} from "./movement";
export { findPath, pathLength, type PathPolicy } from "./pathfind";
export {
  holdsReservation,
  interactionsAt,
  releaseReservations,
  reservationHolders,
  tryReserve,
} from "./reservations";
export { actorPolicy, schematicPolicy } from "./routing";
export { navRefreshSystem } from "./topology";

/**
 * Register the spatial cache builder and systems. Call before `createWorld`/`restore` so the nav
 * cache is built. Order within phase 3: doors, then movement (movement sees this tick's doors).
 */
export function registerSpatial(registry: KernelRegistry): () => void {
  const undo = [
    registry.registerCacheBuilder(navCacheBuilder),
    registry.registerSystem(navRefreshSystem),
    registry.registerSystem(doorsSystem),
    registry.registerSystem(movementSystem),
  ];
  return () => {
    for (const off of undo.reverse()) off();
  };
}
