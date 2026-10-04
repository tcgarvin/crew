/**
 * A* over tile centres (SD §7.2). Cardinal steps cost 1, diagonal √2. A diagonal is refused when
 * either orthogonal neighbour is not walkable or any of the four edges it slips past is a wall or
 * a door: doors are crossed only orthogonally through their own edge.
 *
 * Door passability comes from a `PathPolicy` so the same search serves the static schematic
 * (estimates) and an actor's knowledge (routes). A door the policy says "will open for me" costs
 * its opening time converted to tiles at walking speed; `null` means impassable (e.g. jammed).
 */
import type { EdgeSide, TileCoord } from "../../core/types/common";
import type { DoorId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { DerivedCaches } from "../../core/types/pipeline";
import {
  SIDE_BIT,
  doorOnEdge,
  inBounds,
  isStaticWalkable,
  tileAtIndex,
  tileIndex,
} from "./geometry";

export interface PathPolicy {
  /** Cache key for results under this policy; omit to skip the cache. */
  readonly key?: string;
  /** Extra cost in tiles to cross this door, or `null` if it will not let the actor through. */
  doorCost(doorId: DoorId): number | null;
  /** Planning-time blockage beyond static floor and machine footprints. */
  tileBlocked(x: number, y: number): boolean;
}

const SQRT2 = Math.SQRT2;

/** Length in tiles of one step between adjacent tile centres. */
export function stepLength(a: TileCoord, b: TileCoord): number {
  return a.x !== b.x && a.y !== b.y ? SQRT2 : 1;
}

/** Geometric length of a path in tiles (door costs excluded). */
export function pathLength(path: readonly TileCoord[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += stepLength(path[i - 1] as TileCoord, path[i] as TileCoord);
  }
  return total;
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
}

/** Binary min-heap of node indices ordered by (f, -g) held in parallel arrays. */
class NodeHeap {
  private readonly nodes: number[] = [];
  private readonly fs: number[] = [];
  private readonly gs: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  private less(i: number, j: number): boolean {
    const fi = this.fs[i] as number;
    const fj = this.fs[j] as number;
    if (fi !== fj) return fi < fj;
    // Prefer deeper nodes on ties: fewer re-expansions along straight corridors.
    return (this.gs[i] as number) > (this.gs[j] as number);
  }

  // Unrolled over the three arrays: this runs on every heap step, so no per-call array literal.
  private swap(i: number, j: number): void {
    const { nodes, fs, gs } = this;
    const node = nodes[i] as number;
    nodes[i] = nodes[j] as number;
    nodes[j] = node;
    const f = fs[i] as number;
    fs[i] = fs[j] as number;
    fs[j] = f;
    const g = gs[i] as number;
    gs[i] = gs[j] as number;
    gs[j] = g;
  }

  push(node: number, f: number, g: number): void {
    this.nodes.push(node);
    this.fs.push(f);
    this.gs.push(g);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.nodes[0] as number;
    const last = this.nodes.length - 1;
    this.swap(0, last);
    this.nodes.pop();
    this.fs.pop();
    this.gs.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let best = i;
      if (l < this.nodes.length && this.less(l, best)) best = l;
      if (r < this.nodes.length && this.less(r, best)) best = r;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
    return top;
  }
}

/** Each cardinal step with the side of the current tile it crosses. */
const CARDINALS: readonly (readonly [number, number, EdgeSide])[] = [
  [0, -1, "n"],
  [1, 0, "e"],
  [0, 1, "s"],
  [-1, 0, "w"],
];
/** Each diagonal step with the edge bits of its horizontal (`e`/`w`) and vertical (`n`/`s`) sides. */
const DIAGONALS: readonly (readonly [number, number, number, number])[] = [
  [1, -1, SIDE_BIT.e, SIDE_BIT.n],
  [1, 1, SIDE_BIT.e, SIDE_BIT.s],
  [-1, 1, SIDE_BIT.w, SIDE_BIT.s],
  [-1, -1, SIDE_BIT.w, SIDE_BIT.n],
];

/**
 * Shortest route from `from` to `to` as tile centres (both ends included), or `null` if there is
 * none. `from` may be any floor tile (an actor can stand on a tile that has since become
 * obstructed); `to` must be walkable under the policy. The open set is bounded by the number of
 * directed tile steps (8 × tiles), so the search always terminates.
 */
export function findPath(
  geometry: DeckGeometry,
  from: TileCoord,
  to: TileCoord,
  policy: PathPolicy,
): TileCoord[] | null {
  if (!inBounds(geometry, from.x, from.y) || geometry.floor[tileIndex(geometry, from)] !== 1) {
    return null;
  }
  const walkable = (x: number, y: number) =>
    isStaticWalkable(geometry, x, y) && !policy.tileBlocked(x, y);
  if (!walkable(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];

  const { width, originX, originY, walls, doorSides } = geometry;
  // `indexAt` inlined for the inner loops (callers have bounds-checked through `walkable`).
  const indexOf = (x: number, y: number) => (y - originY) * width + (x - originX);
  const size = width * geometry.height;
  const g = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const start = tileIndex(geometry, from);
  const goal = tileIndex(geometry, to);
  const heap = new NodeHeap();
  const maxOpen = size * 8 + 1;
  g[start] = 0;
  heap.push(start, octile(from.x, from.y, to.x, to.y), 0);

  const relax = (node: number, next: number, cost: number) => {
    const candidate = (g[node] as number) + cost;
    if (candidate >= (g[next] as number)) return;
    g[next] = candidate;
    parent[next] = node;
    if (heap.size < maxOpen) {
      // `tileAtIndex` inlined: relax is the hot path, so keep it allocation-free.
      const gx = next % width;
      const nx = gx + originX;
      const ny = (next - gx) / width + originY;
      heap.push(next, candidate + octile(nx, ny, to.x, to.y), candidate);
    }
  };

  while (heap.size > 0) {
    const node = heap.pop();
    if (closed[node] === 1) continue;
    if (node === goal) break;
    closed[node] = 1;
    const gx = node % width;
    const x = gx + originX;
    const y = (node - gx) / width + originY;
    // Edge bits read straight from the grids: `node` and every walkable neighbour are on the
    // grid, so `hasWall`'s off-grid case never applies, and the string-keyed `doorByEdge` lookup
    // is only worth doing where `doorSides` says a door is.
    const wallsHere = walls[node] as number;
    const doorsHere = doorSides[node] as number;

    for (const [dx, dy, side] of CARDINALS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!walkable(nx, ny)) continue;
      const bit = SIDE_BIT[side];
      let cost = 1;
      const doorId = (doorsHere & bit) !== 0 ? doorOnEdge(geometry, { x, y }, side) : undefined;
      if (doorId !== undefined) {
        const extra = policy.doorCost(doorId);
        if (extra === null) continue;
        cost += extra;
      } else if ((wallsHere & bit) !== 0) {
        continue;
      }
      relax(node, indexOf(nx, ny), cost);
    }

    const edgesHere = wallsHere | doorsHere;
    for (const [dx, dy, xBit, yBit] of DIAGONALS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!walkable(nx, ny) || !walkable(nx, y) || !walkable(x, ny)) continue;
      // Refused if any of the four edges the diagonal slips past is a wall or a door.
      if ((edgesHere & (xBit | yBit)) !== 0) continue;
      const besideX = indexOf(nx, y);
      if ((((walls[besideX] as number) | (doorSides[besideX] as number)) & yBit) !== 0) continue;
      const besideY = indexOf(x, ny);
      if ((((walls[besideY] as number) | (doorSides[besideY] as number)) & xBit) !== 0) continue;
      relax(node, indexOf(nx, ny), SQRT2);
    }
  }

  if (parent[goal] === -1) return null;
  const path: TileCoord[] = [];
  for (let node = goal; node !== -1; node = parent[node] as number) {
    path.push(tileAtIndex(geometry, node));
    if (node === start) break;
  }
  return path.reverse();
}

/**
 * `findPath` through the nav cache, keyed by deck, policy key, from and to. The cache is cleared
 * when the geometry revision changes, and dropped wholesale if it grows past 4 entries per tile
 * (a memory bound, not a tuning knob).
 */
export function cachedPath(
  caches: DerivedCaches,
  geometry: DeckGeometry,
  from: TileCoord,
  to: TileCoord,
  policy: PathPolicy,
): readonly TileCoord[] | null {
  if (policy.key === undefined) return findPath(geometry, from, to, policy);
  const key = `${geometry.deckId}|${policy.key}|${from.x},${from.y}|${to.x},${to.y}`;
  const paths = caches.nav.paths;
  const hit = paths.get(key);
  if (hit !== undefined) return hit;
  const path = findPath(geometry, from, to, policy);
  if (paths.size >= geometry.width * geometry.height * 4) paths.clear();
  paths.set(key, path);
  return path;
}
