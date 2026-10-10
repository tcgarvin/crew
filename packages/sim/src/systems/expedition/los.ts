/**
 * Expeditions A1 (§8.1, plan call 8): lines of sight and cover over the site map, by a tile walk
 * from tile centre to tile centre (every tile the segment passes through). A line is blocked by a
 * `wall` tile, by void or off the map, or by cover not adjacent (8-adjacent) to either end; the
 * end tiles themselves never block. People never block. Pure over the dock def and
 * `core/sites.ts`.
 *
 * W2 decision: where the segment passes exactly through a tile corner it touches the two tiles
 * beside the corner; it is blocked there only when both block, so two walls meeting at a corner
 * close the crack but a single wall corner does not hide a doorway seen at 45°.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import type { BerthedDock } from "../../core/docks";
import { isCover, tileKindAt } from "../../core/sites";
import type { TileCoord } from "../../core/types/common";

const EPS = 1e-9;

/** Are `a` and `b` the same tile or 8-neighbours? */
export function adjacent8(a: TileCoord, b: TileCoord): boolean {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;
}

/**
 * Walk the tiles strictly between `from` and `to` along the centre-to-centre segment. `visit`
 * gets one tile, or the pair beside a corner the segment passes exactly through; it returns true
 * to stop the walk. Returns whether the walk was stopped.
 */
function walkBetween(
  from: TileCoord,
  to: TileCoord,
  visit: (tiles: readonly TileCoord[]) => boolean,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  // Parametric distance (t in [0, 1]) between grid lines crossed, and to the first, from the
  // centre of `from`.
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dx);
  const deltaY = dy === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(dy);
  let tMaxX = deltaX / 2;
  let tMaxY = deltaY / 2;
  let x = from.x;
  let y = from.y;
  while (x !== to.x || y !== to.y) {
    if (Math.abs(tMaxX - tMaxY) < EPS) {
      // Exactly through a corner: the two tiles beside it, then on to the diagonal tile.
      const beside = [
        { x: x + stepX, y },
        { x, y: y + stepY },
      ];
      x += stepX;
      y += stepY;
      tMaxX += deltaX;
      tMaxY += deltaY;
      if (visit(beside)) return true;
    } else if (tMaxX < tMaxY) {
      x += stepX;
      tMaxX += deltaX;
    } else {
      y += stepY;
      tMaxY += deltaY;
    }
    if (x === to.x && y === to.y) break;
    if (visit([{ x, y }])) return true;
  }
  return false;
}

/** Does deck-frame tile `tile` block a line from `from` to `to` (neither of which it is)? */
function blocks(berth: BerthedDock, tile: TileCoord, from: TileCoord, to: TileCoord): boolean {
  const kind = tileKindAt(berth, tile);
  if (kind === undefined || kind === "wall" || kind === "void") return true;
  if (!isCover(berth, tile)) return false;
  return !adjacent8(tile, from) && !adjacent8(tile, to);
}

/** Can someone at deck-frame tile `from` see (and shoot) someone at `to`? */
export function lineOfSight(berth: BerthedDock, from: TileCoord, to: TileCoord): boolean {
  if (from.x === to.x && from.y === to.y) return true;
  return !walkBetween(from, to, (tiles) => tiles.every((t) => blocks(berth, t, from, to)));
}

/**
 * Is someone at `tile` in cover from a shot from `from`: does a cover tile adjacent to `tile` lie
 * on the line between them?
 */
export function inCover(berth: BerthedDock, tile: TileCoord, from: TileCoord): boolean {
  if (from.x === tile.x && from.y === tile.y) return false;
  return walkBetween(from, tile, (tiles) =>
    tiles.some((t) => adjacent8(t, tile) && isCover(berth, t)),
  );
}
