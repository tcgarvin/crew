/**
 * Dockside §3.1 (phase 2): what the renderer reads off a dock map once, memoized per def: the tile
 * grid as row runs per kind, the berth's box, the edges where the berth meets the quay and where
 * walls meet floor, and how the berth is drawn; `dockSurface` adds the floor's look once the
 * port's setting is known. Pure; dock frame (tile (0,0) is the map's top-left).
 */
import type { DockDef, DockTileKind, PortSetting } from "@crew/sim";
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
 * How the berth (the ship's footprint) is drawn when the hull does not cover it, which is while
 * the dock slides: a `pad` set into the floor when the quay surrounds it, an `open` slot (a bay
 * pit at a station, sky at a pier) when it mostly borders walls or void.
 */
export type BerthStyle = "pad" | "open";

/** Floor surface: station plating, pier boards (a planet berth open to the sky), or slabs. */
export type FloorPattern = "plates" | "planks" | "slabs";

export interface DockShape {
  /** Row-major tile kinds, `width × height`. */
  readonly kinds: readonly DockTileKind[];
  readonly runs: Readonly<Record<DockTileKind, readonly TileRun[]>>;
  /** Tile box of the berth tiles (exclusive max). */
  readonly berth: Bounds;
  readonly berthStyle: BerthStyle;
  /** Where the berth meets floor: the quay's edge, hazard-striped. */
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
  const runs: Record<DockTileKind, TileRun[]> = { floor: [], wall: [], void: [], berth: [] };
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
 * Every edge between a `kind` tile and a floor tile, merged into straight runs. The normal points
 * from the `kind` tile into the floor.
 */
function edgesToFloor(
  kinds: readonly DockTileKind[],
  width: number,
  height: number,
  kind: DockTileKind,
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
        const hit = i < along && at(x, y) === kind && at(x + dx, y + dy) === "floor";
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

function berthBox(kinds: readonly DockTileKind[], width: number, dockId: string): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  kinds.forEach((kind, i) => {
    if (kind !== "berth") return;
    const x = i % width;
    const y = Math.floor(i / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 1);
    maxY = Math.max(maxY, y + 1);
  });
  if (minX === Number.POSITIVE_INFINITY) throw new Error(`Dock "${dockId}" has no berth tiles`);
  return { minX, minY, maxX, maxY };
}

/** The share of tiles around the berth's box that are floor. */
function quayShare(
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
  for (let x = berth.minX; x < berth.maxX; x++) {
    count(x, berth.minY - 1);
    count(x, berth.maxY);
  }
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
  const berth = berthBox(kinds, width, dock.id);
  const shape: DockShape = {
    kinds,
    runs,
    berth,
    berthStyle: quayShare(kinds, width, height, berth) >= 0.5 ? "pad" : "open",
    quay: edgesToFloor(kinds, width, height, "berth"),
    lips: edgesToFloor(kinds, width, height, "wall"),
  };
  shapes.set(dock, shape);
  return shape;
}

/** How a dock's ground reads, which depends on its port being a station or a planet (D61). */
export interface DockSurface {
  readonly floorPattern: FloorPattern;
  /**
   * A planet map whose berth is open: the ship hangs beside a pier with open sky below, so the
   * ground far beneath is cloud rather than fields.
   */
  readonly overSky: boolean;
}

export function dockSurface(
  shape: Pick<DockShape, "berthStyle">,
  setting: PortSetting,
): DockSurface {
  const overSky = setting === "planet" && shape.berthStyle === "open";
  return {
    floorPattern: setting === "station" ? "plates" : overSky ? "planks" : "slabs",
    overSky,
  };
}

/** The tile kind at dock tile (x, y), or `void` off the map. */
export function dockTileKind(dock: DockDef, x: number, y: number): DockTileKind {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= dock.width || ty >= dock.height) return "void";
  return dockShape(dock).kinds[ty * dock.width + tx] ?? "void";
}
