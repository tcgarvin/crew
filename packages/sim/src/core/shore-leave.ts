/**
 * §shore-leave: where the crew sit ashore on leave, and who is ashore on leave now. Pure over state
 * and content, for the agent view (common knowledge: everyone sees who goes down the ramp), the
 * `recreate` plan and its venues, invariants and the render.
 */
import {
  type BerthedDock,
  EDGE_STEP,
  dockAlongsideAt,
  dockToDeck,
  isDockFloor,
  isOnDock,
} from "./docks";
import type { Actor } from "./types/actor";
import type { DeepReadonly, Tick, TileCoord } from "./types/common";
import {
  type ConfigDef,
  type ContentBundle,
  type DockPostDef,
  HULL_SIZE_BOX,
  type ShorePostKind,
} from "./types/content";
import type { LocalKey } from "./types/ids";
import type { DockPresence } from "./types/ship";
import type { TravelState } from "./types/travel";

type ShoreContent = Pick<ContentBundle, "docks" | "decks">;
type ShoreHost = {
  readonly deck: { readonly dock?: DeepReadonly<DockPresence> };
  readonly travel: DeepReadonly<TravelState>;
};
type ShoreConfig = {
  readonly time: Pick<ConfigDef["time"], "tickRate">;
  readonly recreation: Pick<ConfigDef["recreation"], "shoreLeaveMinDockedSeconds">;
};

/** How far (tiles, either axis) from a post's counter side someone on leave sits. */
const SPOT_REACH = 2;

/**
 * The dock alongside, if the ship lies docked at a port there with its ramps down at least
 * `recreation.shoreLeaveMinDockedSeconds`: the only time anyone goes ashore on leave, a course set
 * or not. Never at a landing site, in departure prep or under way. Whether a new leave may start
 * once a course is set is the planner's call (`planner/recreation.ts`).
 */
export function shoreLeaveDock(
  content: ShoreContent,
  config: ShoreConfig,
  state: ShoreHost & { readonly tick: Tick },
): BerthedDock | undefined {
  const travel = state.travel;
  if (travel.stage !== "docked") return undefined;
  const since = travel.dockedSinceTick;
  const minTicks = config.recreation.shoreLeaveMinDockedSeconds * config.time.tickRate;
  if (since !== undefined && state.tick - since < minTicks) return undefined;
  const berth = dockAlongsideAt(content, state, travel.portId);
  return berth === undefined || berth.dock.kind === "site" ? undefined : berth;
}

/** The dock's first post of `kind`, the one a shore-leave venue of that kind means. */
export function shorePost(berth: BerthedDock, kind: ShorePostKind): DockPostDef | undefined {
  return berth.dock.posts.find((post) => post.kind === kind);
}

/** A post of the dock by key. */
export function shorePostByKey(berth: BerthedDock, key: LocalKey): DockPostDef | undefined {
  return berth.dock.posts.find((post) => post.key === key);
}

/**
 * Where someone on leave stands by `post`, deck frame, nearest the post first: dock floor within
 * `SPOT_REACH` of the tile the post faces, never on a post or the tile it faces (the counter is
 * the buyers' and the post the local's), an area (freight work), or beside the berth box (the
 * ramp landings).
 */
export function shoreSpots(berth: BerthedDock, post: DockPostDef): TileCoord[] {
  const dock = berth.dock;
  const step = EDGE_STEP[post.facing];
  const front = { x: post.tile.x + step.x, y: post.tile.y + step.y };
  const reserved = new Set<string>();
  for (const other of dock.posts) {
    const s = EDGE_STEP[other.facing];
    reserved.add(`${other.tile.x},${other.tile.y}`);
    reserved.add(`${other.tile.x + s.x},${other.tile.y + s.y}`);
  }
  const box = HULL_SIZE_BOX[dock.berth.sizeClass];
  const nearBerth = (x: number, y: number): boolean =>
    x >= dock.berth.origin.x - 1 &&
    x <= dock.berth.origin.x + box.w &&
    y >= dock.berth.origin.y - 1 &&
    y <= dock.berth.origin.y + box.h;
  const inArea = (x: number, y: number): boolean =>
    dock.areas.some(
      (a) => x >= a.rect.x && x < a.rect.x + a.rect.w && y >= a.rect.y && y < a.rect.y + a.rect.h,
    );
  const out: { tile: TileCoord; d: number }[] = [];
  for (let dy = -SPOT_REACH; dy <= SPOT_REACH; dy++) {
    for (let dx = -SPOT_REACH; dx <= SPOT_REACH; dx++) {
      const x = front.x + dx;
      const y = front.y + dy;
      if (!isDockFloor(dock, x, y) || reserved.has(`${x},${y}`)) continue;
      if (nearBerth(x, y) || inArea(x, y)) continue;
      out.push({ tile: dockToDeck(berth, { x, y }), d: Math.abs(dx) + Math.abs(dy) });
    }
  }
  return out
    .sort((a, b) => a.d - b.d || a.tile.y - b.tile.y || a.tile.x - b.tile.x)
    .map((s) => s.tile);
}

/**
 * Is `actor` ashore on leave: at a `recreate` step standing on the dock, or with a walk onto the
 * dock still ahead in their `recreate` plan? Someone on the dock walking back aboard to a game is
 * not. The `recreation.ashoreMax` cap counts these.
 */
export function isOnShoreLeave(
  content: ShoreContent,
  state: ShoreHost,
  actor: DeepReadonly<Actor>,
): boolean {
  const activity = actor.activity;
  if (activity.kind !== "personal" || activity.activity !== "recreate") return false;
  const presence = state.deck.dock;
  const plan = activity.plan;
  if (presence === undefined || plan === undefined) return false;
  if (plan.steps[plan.stepIndex]?.kind === "recreate") {
    return isOnDock(content, state, actor.location);
  }
  return plan.steps.slice(plan.stepIndex).some((step) => {
    if (step.kind !== "moveTo" || "machineId" in step.target) return false;
    const { x, y } = step.target;
    return isOnDock(content, state, { kind: "onDeck", deckId: presence.deckId, x, y });
  });
}
