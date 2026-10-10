/**
 * Expeditions A1 (§8.1, plan call 8): lines of sight and cover over the site map, by a supercover
 * tile walk (every tile the segment touches): blocked by a `wall` tile, by void, or by cover not
 * adjacent to either end. People never block. Pure over the dock def and `core/sites.ts`.
 *
 * Gate stub: throws until W2 writes it (nothing calls it yet).
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import type { BerthedDock } from "../../core/docks";
import { NotImplementedError } from "../../core/registry";
import type { TileCoord } from "../../core/types/common";

/** Can someone at deck-frame tile `from` see (and shoot) someone at `to`? */
export function lineOfSight(_berth: BerthedDock, _from: TileCoord, _to: TileCoord): boolean {
  throw new NotImplementedError("lineOfSight (expeditions A1 W2)");
}
