/**
 * Planner-facing travel estimates over the static schematic (SD §13.5: every crew member knows
 * the layout). Pure: no state, no facts, no dynamic doors except ramps, which are open or not as
 * the geometry last saw them (Dockside spike: a dock tile is reachable only across an open ramp).
 * The AgentView builder (W4a) can wrap these for the planner, which may not import `systems/**`.
 */
import type { TileCoord } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";
import type { DeckGeometry } from "../../core/types/nav";
import type { DerivedCaches } from "../../core/types/pipeline";
import { doorBetween } from "./geometry";
import { cachedPath, findPath, pathLength } from "./pathfind";
import { plannedDoorSeconds, schematicPolicy } from "./routing";

/**
 * Route the schematic suggests from `from` to `to`, or null if the layout has none. With
 * `caches`, through the nav path cache (`cachedPath`, schematic key): the schematic changes only
 * with the geometry or a ramp, and both clear that cache. The dock's long walks made these
 * uncached searches the planner's main cost.
 */
export function knownRoute(
  geometry: DeckGeometry,
  from: TileCoord,
  to: TileCoord,
  config: ConfigDef,
  caches?: DerivedCaches,
): readonly TileCoord[] | null {
  const policy = schematicPolicy(geometry, config);
  return caches === undefined
    ? findPath(geometry, from, to, policy)
    : cachedPath(caches, geometry, from, to, policy);
}

/**
 * Ticks to walk the schematic route at `walkSpeed × speedFactor`, plus each door's schematic
 * opening time; null if unreachable. Ignores congestion and waiting for positions.
 */
export function estimateTravelTicks(
  geometry: DeckGeometry,
  from: TileCoord,
  to: TileCoord,
  config: ConfigDef,
  speedFactor = 1,
  caches?: DerivedCaches,
): number | null {
  const route = knownRoute(geometry, from, to, config, caches);
  if (route === null) return null;
  let seconds = pathLength(route) / (config.movement.walkSpeed * speedFactor);
  for (let i = 1; i < route.length; i++) {
    const doorId = doorBetween(geometry, route[i - 1] as TileCoord, route[i] as TileCoord);
    const nav = doorId === undefined ? undefined : geometry.doors.get(doorId);
    if (nav !== undefined) seconds += plannedDoorSeconds(geometry, nav, config) ?? 0;
  }
  return Math.ceil(seconds * config.time.tickRate - 1e-9);
}
