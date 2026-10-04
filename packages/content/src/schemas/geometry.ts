/** Tile-grid helpers shared by the deck and dock validators. */
import type { DockRect, TileCoord, TileEdge } from "@crew/sim";

/** The step from a tile to its neighbour across each side (y grows south). */
export const SIDE_OFFSET: Readonly<Record<TileEdge["side"], TileCoord>> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

/** The tile on the far side of an edge. */
export function neighborTile(edge: TileEdge): TileCoord {
  const d = SIDE_OFFSET[edge.side];
  return { x: edge.x + d.x, y: edge.y + d.y };
}

export function tileKey(t: TileCoord): string {
  return `${t.x},${t.y}`;
}

/** `(x,y)`, as tiles appear in issue messages. */
export function at(t: TileCoord): string {
  return `(${t.x},${t.y})`;
}

export function rectTiles(rect: DockRect): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) tiles.push({ x, y });
  }
  return tiles;
}

export function rectContains(rect: DockRect, t: TileCoord): boolean {
  return t.x >= rect.x && t.x < rect.x + rect.w && t.y >= rect.y && t.y < rect.y + rect.h;
}
