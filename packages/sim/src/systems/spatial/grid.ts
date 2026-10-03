/**
 * Index arithmetic for nav grids. A grid's origin is the deck coordinate of index 0: (0,0) for a
 * bare deck, negative when a grafted dock extends fore of or above the ship (Dockside spike).
 * Every tile-array access goes through these, never `y * width + x`.
 */
import type { TileCoord } from "../../core/types/common";
import type { DeckGeometry } from "../../core/types/nav";

/** The extent of a nav grid in deck coordinates. */
export type Grid = Pick<DeckGeometry, "originX" | "originY" | "width" | "height">;

export function inBounds(grid: Grid, x: number, y: number): boolean {
  const gx = x - grid.originX;
  const gy = y - grid.originY;
  return gx >= 0 && gy >= 0 && gx < grid.width && gy < grid.height;
}

/** Grid index of an in-bounds tile (callers check `inBounds` first). */
export function indexAt(grid: Grid, x: number, y: number): number {
  return (y - grid.originY) * grid.width + (x - grid.originX);
}

export function tileIndex(grid: Grid, tile: TileCoord): number {
  return indexAt(grid, tile.x, tile.y);
}

/** Deck coordinates of a grid index (inverse of `indexAt`). */
export function tileAtIndex(grid: Grid, index: number): TileCoord {
  const gx = index % grid.width;
  return { x: gx + grid.originX, y: (index - gx) / grid.width + grid.originY };
}
