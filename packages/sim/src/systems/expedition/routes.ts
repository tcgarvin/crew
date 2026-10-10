/**
 * Expeditions A1 (§8.1): the fight's own reading of the site floor, beside the spatial
 * pathfinder (which walks people; these choose where to): a breadth-first search over site floor
 * tiles, the cover spots a `hold` spreads into, the tiles the cast would notice someone on (what
 * `creep` keeps off), and a spot from which a guard can see the party.
 *
 * Pure over the ground; the static answers (cover spots, the watched tiles for a set of watchers)
 * are memoised by their inputs, since the cast stands still for most of an approach.
 *
 * Owner: W2 of expeditions A1.
 */
import { isCover } from "../../core/sites";
import type { TileCoord } from "../../core/types/common";
import { type Ground, distance, standable } from "./ground";
import { adjacent8, inCover, lineOfSight } from "./los";

const key = (t: TileCoord): string => `${t.x},${t.y}`;

const DIRS: readonly TileCoord[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
];

/** Every site floor tile someone can stand on, in the deck frame. */
export function siteTiles(ground: Ground): TileCoord[] {
  const { dock, shipAt } = ground.berth;
  const out: TileCoord[] = [];
  for (let y = 0; y < dock.height; y++) {
    for (let x = 0; x < dock.width; x++) {
      const tile = { x: x - shipAt.x, y: y - shipAt.y };
      if (standable(ground, tile)) out.push(tile);
    }
  }
  return out;
}

/**
 * Breadth-first over site floor (8-connected, no cutting a corner past something unwalkable) from
 * `from` to the first tile `goal` accepts, never entering a tile `avoid` names, at most `maxSteps`
 * steps. The path excludes `from`; undefined when no tile is reached.
 */
export function searchPath(
  ground: Ground,
  from: TileCoord,
  goal: (tile: TileCoord) => boolean,
  options: { readonly avoid?: (tile: TileCoord) => boolean; readonly maxSteps?: number } = {},
): TileCoord[] | undefined {
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
  const parent = new Map<string, TileCoord | null>([[key(from), null]]);
  let frontier: TileCoord[] = [from];
  for (let steps = 0; frontier.length > 0 && steps < maxSteps; steps++) {
    const next: TileCoord[] = [];
    for (const tile of frontier) {
      for (const d of DIRS) {
        const to = { x: tile.x + d.x, y: tile.y + d.y };
        const k = key(to);
        if (parent.has(k) || !standable(ground, to)) continue;
        if (d.x !== 0 && d.y !== 0) {
          const a = { x: tile.x + d.x, y: tile.y };
          const b = { x: tile.x, y: tile.y + d.y };
          if (!standable(ground, a) || !standable(ground, b)) continue;
        }
        if (options.avoid?.(to) === true) continue;
        parent.set(k, tile);
        if (goal(to)) return unwind(parent, to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return undefined;
}

function unwind(parent: Map<string, TileCoord | null>, end: TileCoord): TileCoord[] {
  const path: TileCoord[] = [];
  let at: TileCoord | null | undefined = end;
  while (at !== null && at !== undefined) {
    path.push(at);
    at = parent.get(key(at));
  }
  path.pop();
  return path.reverse();
}

const coverSpotMemo = new Map<string, readonly TileCoord[]>();

/**
 * `hold`'s spots: site floor beside cover, no more than `band` rows past the ramp foot's row,
 * those in cover from `threat` first, then nearest the ramp foot.
 */
export function coverSpots(ground: Ground, threat: TileCoord, band: number): readonly TileCoord[] {
  const memoKey = `${ground.berth.dock.id}|${key(ground.foot)}|${key(threat)}|${band}`;
  const held = coverSpotMemo.get(memoKey);
  if (held !== undefined) return held;
  const scored = siteTiles(ground)
    .filter((t) => Math.abs(t.y - ground.foot.y) <= band && besideCover(ground, t))
    .map((t) => ({
      t,
      score: (inCover(ground.berth, t, threat) ? 0 : 1000) + distance(t, ground.foot),
    }))
    .sort((a, b) => a.score - b.score || a.t.y - b.t.y || a.t.x - b.t.x)
    .map((s) => s.t);
  coverSpotMemo.set(memoKey, scored);
  return scored;
}

/** Is a cover tile 8-adjacent to `tile`? */
export function besideCover(ground: Ground, tile: TileCoord): boolean {
  return DIRS.some((d) => isCover(ground.berth, { x: tile.x + d.x, y: tile.y + d.y }));
}

/** Someone who notices a party member within `radius` tiles they can see. */
export interface Watcher {
  readonly tile: TileCoord;
  readonly radius: number;
}

const watchedMemo = new Map<string, ReadonlySet<string>>();

/** The site tiles some watcher would notice someone on. */
export function watchedTiles(ground: Ground, watchers: readonly Watcher[]): ReadonlySet<string> {
  const memoKey = `${ground.berth.dock.id}|${watchers.map((w) => `${key(w.tile)}:${w.radius}`).join(";")}`;
  const held = watchedMemo.get(memoKey);
  if (held !== undefined) return held;
  const out = new Set<string>();
  for (const tile of siteTiles(ground)) {
    const seen = watchers.some(
      (w) => distance(w.tile, tile) <= w.radius && lineOfSight(ground.berth, w.tile, tile),
    );
    if (seen) out.add(key(tile));
  }
  // The memo is keyed by where the cast stand; a fight sees a handful of such sets.
  if (watchedMemo.size > 256) watchedMemo.clear();
  watchedMemo.set(memoKey, out);
  return out;
}

export const isWatched = (watched: ReadonlySet<string>, tile: TileCoord): boolean =>
  watched.has(key(tile));

/**
 * Ruling 2: a spot within `maxSteps` of `from` with a line to `seen` within `range`, in cover from
 * it if one is, else the nearest. Undefined when none is.
 */
export function spotSeeing(
  ground: Ground,
  from: TileCoord,
  seen: TileCoord,
  range: number,
  maxSteps: number,
): TileCoord | undefined {
  const ok = (t: TileCoord) => distance(t, seen) <= range && lineOfSight(ground.berth, t, seen);
  const covered = searchPath(ground, from, (t) => ok(t) && inCover(ground.berth, t, seen), {
    maxSteps,
  });
  const path = covered ?? searchPath(ground, from, ok, { maxSteps });
  return path?.[path.length - 1];
}

/** Tiles beside `tile` someone can stand on, nearest `toward` first. */
export function standingBeside(ground: Ground, tile: TileCoord, toward: TileCoord): TileCoord[] {
  return DIRS.map((d) => ({ x: tile.x + d.x, y: tile.y + d.y }))
    .filter((t) => standable(ground, t) && adjacent8(t, tile))
    .sort((a, b) => distance(a, toward) - distance(b, toward) || a.y - b.y || a.x - b.x);
}
