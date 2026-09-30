/**
 * A* over tile centres (SD §7.2). Cardinal steps cost 1, diagonal √2. A diagonal is refused when
 * either orthogonal neighbour is not walkable or any of the four edges it slips past is a wall or
 * a door: doors are crossed only orthogonally through their own edge.
 *
 * Door passability comes from a `PathPolicy` so the same search serves the static schematic
 * (estimates) and an actor's knowledge (routes). A door the policy says "will open for me" costs
 * its opening time converted to tiles at walking speed; `null` means impassable (e.g. jammed).
 */
import type { TileCoord } from "../../core/types/common";
import type { DoorId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { DerivedCaches } from "../../core/types/pipeline";
import { SIDE_BIT, doorOnEdge, hasWall, inBounds, isStaticWalkable, sideTowards } from "./geometry";

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

  private swap(i: number, j: number): void {
    for (const arr of [this.nodes, this.fs, this.gs]) {
      const t = arr[i] as number;
      arr[i] = arr[j] as number;
      arr[j] = t;
    }
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

const CARDINALS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const DIAGONALS: readonly [number, number][] = [
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
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
  const { width } = geometry;
  if (!inBounds(geometry, from.x, from.y) || geometry.floor[from.y * width + from.x] !== 1) {
    return null;
  }
  const walkable = (x: number, y: number) =>
    isStaticWalkable(geometry, x, y) && !policy.tileBlocked(x, y);
  if (!walkable(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];

  const size = width * geometry.height;
  const g = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const start = from.y * width + from.x;
  const goal = to.y * width + to.x;
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
      const nx = next % width;
      const ny = (next - nx) / width;
      heap.push(next, candidate + octile(nx, ny, to.x, to.y), candidate);
    }
  };

  while (heap.size > 0) {
    const node = heap.pop();
    if (closed[node] === 1) continue;
    if (node === goal) break;
    closed[node] = 1;
    const x = node % width;
    const y = (node - x) / width;
    const here = { x, y };

    for (const [dx, dy] of CARDINALS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!walkable(nx, ny)) continue;
      const side = sideTowards(here, { x: nx, y: ny });
      if (side === undefined) continue;
      let cost = 1;
      const doorId = doorOnEdge(geometry, here, side);
      if (doorId !== undefined) {
        const extra = policy.doorCost(doorId);
        if (extra === null) continue;
        cost += extra;
      } else if (hasWall(geometry, here, side)) {
        continue;
      }
      relax(node, ny * width + nx, cost);
    }

    for (const [dx, dy] of DIAGONALS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!walkable(nx, ny) || !walkable(nx, y) || !walkable(x, ny)) continue;
      const sx = dx > 0 ? "e" : "w";
      const sy = dy > 0 ? "s" : "n";
      const blocked = (tile: TileCoord, side: "n" | "e" | "s" | "w") =>
        hasWall(geometry, tile, side) ||
        ((geometry.doorSides[tile.y * width + tile.x] ?? 0) & SIDE_BIT[side]) !== 0;
      if (
        blocked(here, sx) ||
        blocked(here, sy) ||
        blocked({ x: nx, y }, sy) ||
        blocked({ x, y: ny }, sx)
      ) {
        continue;
      }
      relax(node, ny * width + nx, SQRT2);
    }
  }

  if (parent[goal] === -1) return null;
  const path: TileCoord[] = [];
  for (let node = goal; node !== -1; node = parent[node] as number) {
    const px = node % width;
    path.push({ x: px, y: (node - px) / width });
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
