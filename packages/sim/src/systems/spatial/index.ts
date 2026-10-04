/**
 * Spatial system (W3): deck geometry, pathfinding, movement, doors, interaction reservations.
 * `registerSpatial(registry)` installs the nav cache builder and the phase 2/3 systems.
 */
import type { KernelRegistry } from "../../core/registry";
import { doorsSystem } from "./doors";
import { navCacheBuilder } from "./geometry";
import { movementSystem } from "./movement";
import { navRefreshSystem } from "./topology";

export { checkDockFitsDeck, compartmentAt, deckGeometry, isWalkable } from "./geometry";
export { type MoveTarget, requestMove } from "./movement";

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
