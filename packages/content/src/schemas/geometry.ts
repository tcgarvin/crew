/** Tile-grid helpers shared by the deck and dock validators. */
import type { DeckDef, DockDef, DockRect, HullSizeClass, TileCoord, TileEdge } from "@crew/sim";

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

/**
 * D72: the box each hull size class fits inside. Mirrors sim `HULL_SIZE_BOX`, which this package
 * may only import as a type; a CLI test holds the two together.
 */
export const HULL_CLASS_BOX: Readonly<
  Record<HullSizeClass, { readonly w: number; readonly h: number }>
> = {
  S: { w: 24, h: 14 },
  M: { w: 36, h: 20 },
  L: { w: 40, h: 24 },
};

/**
 * D72: the dock tile under deck tile (0,0) when `deck` lies in `dock`'s berth box: flush to the
 * box's south edge and centred across it. Mirrors sim `berthPlacement` without its throws (the
 * validator reports a deck too big for the box instead); a CLI test holds the two together.
 */
export function shipAtInBerth(
  dock: Pick<DockDef, "berth">,
  deck: Pick<DeckDef, "width" | "height">,
): TileCoord {
  const box = HULL_CLASS_BOX[dock.berth.sizeClass];
  const { origin } = dock.berth;
  return {
    x: origin.x + Math.floor((box.w - deck.width) / 2),
    y: origin.y + box.h - deck.height,
  };
}
