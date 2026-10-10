/**
 * Dockside §3.1 (phase 2): what the renderer reads off a dock map once, memoized per def: the tile
 * grid as row runs per kind, the berth's box (§berth-boxes: `DockDef.berth`, a size-class box of
 * void), the edges where the box meets the quay and where walls meet floor, and how the berth is
 * drawn; `dockSurface` adds the floor's look once the port's setting is known. Pure; dock frame
 * (tile (0,0) is the map's top-left).
 */
import { type DockDef, type DockTileKind, HULL_SIZE_BOX, type PortSetting } from "@crew/sim";
import type { Bounds } from "./hull";

/** `y` row, tiles `x0` to `x1` (exclusive). */
export interface TileRun {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
}

/**
 * A straight run of tile edges between a tile of one kind and a floor tile, from (x1,y1) to
 * (x2,y2), with `nx, ny` the unit normal pointing into the floor.
 */
export interface FloorEdge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly nx: number;
  readonly ny: number;
}

/**
 * How the berth box is drawn where the hull does not cover it (all of it while the dock slides,
 * and the margin round a ship smaller than the box): a `pad` set into the ground when floor
 * surrounds the box, an `open` slot (a bay pit at a station, sky at a pier) when its sides other
 * than the quay mostly border walls or void.
 */
export type BerthStyle = "pad" | "open";

/**
 * Floor surface: station plating, pier boards (a planet berth open to the sky), slabs, or a landing
 * site's loose ground (expeditions A1, §4: no quay was ever built there).
 */
export type FloorPattern = "plates" | "planks" | "slabs" | "shingle";

export interface DockShape {
  /**
   * Expeditions A1 (§4): a landing site (`DockDef.kind: "site"`), not a dock: the ship sits on the
   * ground, so there is no quay structure and the berth always reads as a pad.
   */
  readonly site: boolean;
  /** Row-major tile kinds, `width × height`. */
  readonly kinds: readonly DockTileKind[];
  readonly runs: Readonly<Record<DockTileKind, readonly TileRun[]>>;
  /** Tile box of the berth (`DockDef.berth`, exclusive max). */
  readonly berth: Bounds;
  readonly berthStyle: BerthStyle;
  /** Where the berth box meets floor: the quay's edge, hazard-striped. */
  readonly quay: readonly FloorEdge[];
  /** Where a wall meets floor: the wall's lit lip and its shadow on the floor. */
  readonly lips: readonly FloorEdge[];
}

const shapes = new WeakMap<DockDef, DockShape>();

function tileKinds(dock: DockDef): DockTileKind[] {
  if (dock.rows.length !== dock.height) {
    throw new Error(`Dock "${dock.id}": ${dock.rows.length} rows, expected ${dock.height}`);
  }
  const kinds: DockTileKind[] = [];
  dock.rows.forEach((row, y) => {
    if (row.length !== dock.width) {
      throw new Error(`Dock "${dock.id}": row ${y} is ${row.length} wide, expected ${dock.width}`);
    }
    for (const ch of row) {
      const kind = dock.legend[ch];
      if (kind === undefined) throw new Error(`Dock "${dock.id}": "${ch}" is not in the legend`);
      kinds.push(kind);
    }
  });
  return kinds;
}

function rowRuns(kinds: readonly DockTileKind[], width: number, height: number) {
  const runs: Record<DockTileKind, TileRun[]> = { floor: [], wall: [], void: [], cover: [] };
  for (let y = 0; y < height; y++) {
    let x0 = 0;
    for (let x = 1; x <= width; x++) {
      const prev = kinds[y * width + x - 1];
      const here = x < width ? kinds[y * width + x] : undefined;
      if (here === prev) continue;
      if (prev !== undefined) runs[prev].push({ y, x0, x1: x });
      x0 = x;
    }
  }
  return runs;
}

const SIDES = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
] as const;

/**
 * Every edge between a `source` tile and a floor tile outside the source, merged into straight
 * runs. The normal points from the source tile into the floor.
 */
function edgesToFloor(
  kinds: readonly DockTileKind[],
  width: number,
  height: number,
  source: (x: number, y: number) => boolean,
): FloorEdge[] {
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? undefined : kinds[y * width + x];
  const edges: FloorEdge[] = [];
  for (const { dx, dy } of SIDES) {
    // Horizontal edges (dy ≠ 0) run along x; vertical ones along y. Walk each line and merge.
    const lines = dy !== 0 ? height : width;
    const along = dy !== 0 ? width : height;
    for (let line = 0; line < lines; line++) {
      let start = -1;
      for (let i = 0; i <= along; i++) {
        const x = dy !== 0 ? i : line;
        const y = dy !== 0 ? line : i;
        const hit =
          i < along && source(x, y) && !source(x + dx, y + dy) && at(x + dx, y + dy) === "floor";
        if (hit && start < 0) start = i;
        if (!hit && start >= 0) {
          if (dy !== 0) {
            const ey = dy > 0 ? line + 1 : line;
            edges.push({ x1: start, y1: ey, x2: i, y2: ey, nx: 0, ny: dy });
          } else {
            const ex = dx > 0 ? line + 1 : line;
            edges.push({ x1: ex, y1: start, x2: ex, y2: i, nx: dx, ny: 0 });
          }
          start = -1;
        }
      }
    }
  }
  return edges;
}

/** §berth-boxes: the berth's tile box, from its origin and size class. */
function berthBox(dock: Pick<DockDef, "berth">): Bounds {
  const { origin, sizeClass } = dock.berth;
  const box = HULL_SIZE_BOX[sizeClass];
  return { minX: origin.x, minY: origin.y, maxX: origin.x + box.w, maxY: origin.y + box.h };
}

function inBox(box: Bounds, x: number, y: number): boolean {
  return x >= box.minX && x < box.maxX && y >= box.minY && y < box.maxY;
}

/**
 * The share of tiles bordering the berth's box on its north, west and east sides that are floor
 * (off the map counts as not). §berth-boxes: the quay along the box's south edge is always floor,
 * so it says nothing about whether the box is a pad set into the ground or an open slot.
 */
function surroundShare(
  kinds: readonly DockTileKind[],
  width: number,
  height: number,
  berth: Bounds,
): number {
  let floor = 0;
  let total = 0;
  const count = (x: number, y: number) => {
    total += 1;
    if (x >= 0 && y >= 0 && x < width && y < height && kinds[y * width + x] === "floor") floor += 1;
  };
  for (let x = berth.minX; x < berth.maxX; x++) count(x, berth.minY - 1);
  for (let y = berth.minY; y < berth.maxY; y++) {
    count(berth.minX - 1, y);
    count(berth.maxX, y);
  }
  return total === 0 ? 0 : floor / total;
}

/** The renderer's reading of a dock map. Throws on a malformed map (content validation forbids). */
export function dockShape(dock: DockDef): DockShape {
  const cached = shapes.get(dock);
  if (cached !== undefined) return cached;
  const { width, height } = dock;
  const kinds = tileKinds(dock);
  const runs = rowRuns(kinds, width, height);
  const berth = berthBox(dock);
  const site = dock.kind === "site";
  const shape: DockShape = {
    site,
    kinds,
    runs,
    berth,
    berthStyle: site || surroundShare(kinds, width, height, berth) >= 0.5 ? "pad" : "open",
    quay: edgesToFloor(kinds, width, height, (x, y) => inBox(berth, x, y)),
    lips: edgesToFloor(
      kinds,
      width,
      height,
      (x, y) => x >= 0 && y >= 0 && x < width && y < height && kinds[y * width + x] === "wall",
    ),
  };
  shapes.set(dock, shape);
  return shape;
}

/** How a dock's ground reads, which depends on its port being a station or a planet. */
export interface DockSurface {
  readonly floorPattern: FloorPattern;
  /**
   * A planet map whose berth is open: the ship hangs beside a pier with open sky below, so the
   * ground far beneath is cloud rather than fields.
   */
  readonly overSky: boolean;
}

export function dockSurface(
  shape: Pick<DockShape, "berthStyle" | "site">,
  setting: PortSetting,
): DockSurface {
  const overSky = setting === "planet" && shape.berthStyle === "open";
  const floorPattern: FloorPattern = shape.site
    ? "shingle"
    : setting === "station"
      ? "plates"
      : overSky
        ? "planks"
        : "slabs";
  return { floorPattern, overSky };
}

/** The tile kind at dock tile (x, y), or `void` off the map. */
export function dockTileKind(dock: DockDef, x: number, y: number): DockTileKind {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= dock.width || ty >= dock.height) return "void";
  return dockShape(dock).kinds[ty * dock.width + tx] ?? "void";
}
