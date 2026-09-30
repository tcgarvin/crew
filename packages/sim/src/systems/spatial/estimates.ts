/**
 * Planner-facing travel estimates over the static schematic (SD §13.5: every crew member knows
 * the layout). Pure: no state, no facts, no dynamic doors. The AgentView builder (W4a) can wrap
 * these for the planner, which may not import `systems/**` itself.
 */
import type { TileCoord } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";
import type { DeckGeometry } from "../../core/types/nav";
import { schematicDoorSeconds } from "./doors";
import { doorBetween } from "./geometry";
import { findPath, pathLength } from "./pathfind";
import { schematicPolicy } from "./routing";

/** Route the schematic suggests from `from` to `to`, or null if the layout has none. */
export function knownRoute(
  geometry: DeckGeometry,
  from: TileCoord,
  to: TileCoord,
  config: ConfigDef,
): readonly TileCoord[] | null {
  return findPath(geometry, from, to, schematicPolicy(geometry, config));
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
): number | null {
  const route = knownRoute(geometry, from, to, config);
  if (route === null) return null;
  let seconds = pathLength(route) / (config.movement.walkSpeed * speedFactor);
  for (let i = 1; i < route.length; i++) {
    const doorId = doorBetween(geometry, route[i - 1] as TileCoord, route[i] as TileCoord);
    const nav = doorId === undefined ? undefined : geometry.doors.get(doorId);
    if (nav !== undefined) seconds += schematicDoorSeconds(nav, config) ?? 0;
  }
  return Math.ceil(seconds * config.time.tickRate - 1e-9);
}
