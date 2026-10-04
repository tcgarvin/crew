/**
 * Placing locals and props on the dock alongside (Dockside §5, D66). Pure over state and content
 * apart from writing `state.dockside` (no nav cache), so world creation, the save migration and
 * the travel system share one implementation. Walking is `systems/travel/locals.ts`.
 *
 * Tiles: a person stands on their post's tile, or (when someone is already there) the nearest
 * free dock floor tile to it; never on a freight area, a ramp landing or another post's tile, so
 * crates, the crew's way aboard and the gate stay clear. Every tile is in the deck frame.
 */
import { dockAreaTiles, dockToDeck, isDockFloor } from "./docks";
import { floorSet } from "./floor-set";
import { allocateId } from "./ids";
import { hashString32 } from "./rng";
import type { EdgeSide, Tick, TileCoord } from "./types/common";
import type { ContentBundle, DockDef, DockPostDef } from "./types/content";
import type {
  DockProp,
  FloorSetEntry,
  Local,
  LocalOrigin,
  StagedPlacement,
  StagingPlan,
} from "./types/dockside";
import type { DeckDefId, LocalId, LocalKey, PortDefId } from "./types/ids";
import type { DockPresence } from "./types/ship";
import type { WorldState } from "./types/state";

/** How far (tiles, 4-connected) from a post a local or prop may be set down. */
const PLACEMENT_RADIUS = 6;

const FACING_RADIANS: Readonly<Record<EdgeSide, number>> = {
  e: 0,
  s: Math.PI / 2,
  w: Math.PI,
  n: -Math.PI / 2,
};

const tileKey = (t: TileCoord) => `${t.x},${t.y}`;

/** Which way someone at `post` faces, in radians. */
export function postFacing(post: Pick<DockPostDef, "facing">): number {
  return FACING_RADIANS[post.facing];
}

/** A uint32 palette seed for a person's dot, from their name. */
export function lookSeedOf(name: string): number {
  return hashString32(name.toLowerCase());
}

/**
 * Dock tiles (deck frame) just outside each ramp door: where the crew step off. `only` limits it
 * to one ramp, by its door placement key.
 */
function rampLandings(
  content: ContentBundle,
  deckId: DeckDefId,
  dock: DockDef,
  only?: LocalKey,
): TileCoord[] {
  const deck = content.decks[deckId];
  if (deck === undefined) return [];
  const step: Readonly<Record<EdgeSide, TileCoord>> = {
    n: { x: 0, y: -1 },
    e: { x: 1, y: 0 },
    s: { x: 0, y: 1 },
    w: { x: -1, y: 0 },
  };
  const out: TileCoord[] = [];
  for (const door of deck.doors) {
    if (door.kind !== "ramp" || (only !== undefined && door.key !== only)) continue;
    const { x, y, side } = door.edge;
    const across = { x: x + step[side].x, y: y + step[side].y };
    for (const tile of [{ x, y }, across]) {
      if (isDockFloor(dock, tile.x + dock.shipAt.x, tile.y + dock.shipAt.y)) out.push(tile);
    }
  }
  return out;
}

/**
 * D70: the dock tile at the foot of the personnel ramp (deck frame), where the captain steps off
 * to look for work and where people with word for the captain come to. Any ramp's foot when the
 * deck names no personnel ramp on this dock.
 */
export function personnelRampFoot(
  content: ContentBundle,
  deckId: DeckDefId,
  dock: DockDef,
): TileCoord | undefined {
  const key = content.decks[deckId]?.docking.personnelRampDoorKey;
  const [foot] = key === undefined ? [] : rampLandings(content, deckId, dock, key);
  return foot ?? rampLandings(content, deckId, dock)[0];
}

/**
 * D70: where someone with word for the captain waits: the free dock floor nearest the foot of
 * the personnel ramp, off the landing itself so the way aboard stays clear.
 */
export function waitingSpotByRamp(
  state: Pick<WorldState, "dockside">,
  content: ContentBundle,
  deckId: DeckDefId,
  dock: DockDef,
): TileCoord | undefined {
  const foot = personnelRampFoot(content, deckId, dock);
  if (foot === undefined) return undefined;
  return freeTileNear(
    dock,
    foot,
    localTiles(state),
    reservedTiles(content, deckId, dock, undefined),
  );
}

/** Tiles nothing staged may stand on: freight areas, ramp landings, every post but `own`. */
function reservedTiles(
  content: ContentBundle,
  deckId: DeckDefId,
  dock: DockDef,
  own: LocalKey | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const tile of dockAreaTiles(dock, "freightStaging")) out.add(tileKey(tile));
  for (const tile of dockAreaTiles(dock, "deliveryBay")) out.add(tileKey(tile));
  for (const tile of rampLandings(content, deckId, dock)) out.add(tileKey(tile));
  for (const post of dock.posts) {
    if (post.key !== own) out.add(tileKey(dockToDeck(dock, post.tile)));
  }
  return out;
}

/** Tiles (deck frame) where a local stands, or is walking to, right now. */
export function localTiles(state: Pick<WorldState, "dockside">): Set<string> {
  const out = new Set<string>();
  for (const local of Object.values(state.dockside.locals)) {
    out.add(tileKey({ x: Math.floor(local.location.x), y: Math.floor(local.location.y) }));
    const end =
      local.movement.kind === "moving"
        ? local.movement.path[local.movement.path.length - 1]
        : undefined;
    if (end !== undefined) out.add(tileKey(end));
  }
  return out;
}

/**
 * The nearest dock floor tile to `from` (deck frame, breadth first, 4-connected, within
 * `PLACEMENT_RADIUS`) that is in neither `taken` nor `reserved`; `from` itself first. Undefined
 * when everything near is full. The search walks through taken and reserved tiles, only never
 * stops on one.
 */
export function freeTileNear(
  dock: DockDef,
  from: TileCoord,
  taken: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): TileCoord | undefined {
  const floor = (t: TileCoord) => isDockFloor(dock, t.x + dock.shipAt.x, t.y + dock.shipAt.y);
  const seen = new Set<string>([tileKey(from)]);
  let frontier: TileCoord[] = [from];
  for (let depth = 0; depth <= PLACEMENT_RADIUS && frontier.length > 0; depth++) {
    const next: TileCoord[] = [];
    for (const tile of frontier) {
      const key = tileKey(tile);
      if (floor(tile) && !taken.has(key) && !reserved.has(key)) return tile;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const n = { x: tile.x + dx, y: tile.y + dy };
        const nKey = tileKey(n);
        if (seen.has(nKey) || !floor(n)) continue;
        seen.add(nKey);
        next.push(n);
      }
    }
    frontier = next;
  }
  return undefined;
}

/** What a local is, before a tile is chosen for them. */
export interface LocalSpec {
  readonly name: string;
  readonly role: string;
  readonly origin: LocalOrigin;
  readonly postKey: LocalKey;
  readonly label?: string;
  readonly look?: string;
  readonly carrying?: readonly Local["carrying"][number][];
}

/** Ticks until a local at their post next shuffles: `every` plus a per-person offset. */
export function nextShuffleTick(id: LocalId, tick: Tick, everyTicks: number): Tick {
  const spread = Math.max(1, everyTicks);
  return tick + spread + (hashString32(`${id}:${tick}`) % spread);
}

/** Create a local standing on `tile` (deck frame), at their post. Returns the new record. */
export function spawnLocal(
  state: WorldState,
  deckId: DeckDefId,
  spec: LocalSpec,
  tile: TileCoord,
  facing: number,
  tick: Tick,
  shuffleTicks: number,
): Local {
  const id = allocateId(state, "local");
  const local: Local = {
    id,
    name: spec.name,
    role: spec.role,
    lookSeed: lookSeedOf(spec.name),
    ...(spec.look === undefined ? {} : { look: spec.look }),
    origin: spec.origin,
    postKey: spec.postKey,
    ...(spec.label === undefined ? {} : { label: spec.label }),
    location: { deckId, x: tile.x + 0.5, y: tile.y + 0.5 },
    facing,
    movement: { kind: "stationary" },
    behaviour: {
      kind: "atPost",
      home: { x: tile.x, y: tile.y },
      nextShuffleTick: nextShuffleTick(id, tick, shuffleTicks),
    },
    carrying: [...(spec.carrying ?? [])],
  };
  state.dockside.locals[id] = local;
  return local;
}

/** A staged placement as a local spec, with the role a seed takes from content. */
function stagedSpec(
  content: ContentBundle,
  portId: PortDefId,
  placement: StagedPlacement,
): LocalSpec | undefined {
  const who = placement.who;
  const label = placement.label === undefined ? {} : { label: placement.label };
  const origin: LocalOrigin = { kind: "staged", source: who.kind };
  switch (who.kind) {
    case "seed": {
      const seed = content.ports[portId]?.castSeed.find(
        (s) => s.name.toLowerCase() === who.name.toLowerCase(),
      );
      if (seed === undefined) return undefined;
      return { name: seed.name, role: seed.role, origin, postKey: placement.postKey, ...label };
    }
    case "cast":
      return { name: who.name, role: who.role, origin, postKey: placement.postKey, ...label };
    case "newFace":
      return {
        name: who.name,
        role: who.role,
        origin,
        postKey: placement.postKey,
        look: who.look,
        ...label,
      };
  }
}

function floorSpec(entry: FloorSetEntry): LocalSpec {
  return {
    name: entry.name,
    role: entry.role,
    origin: entry.reason,
    postKey: entry.postKey,
    ...(entry.label === undefined ? {} : { label: entry.label }),
  };
}

/**
 * The people for this docking: the floor set, then the plan's placements. A placement naming
 * someone already in the floor set moves them (and gives them the plan's label) instead of
 * adding a second one; the plan's people keep the order it gave.
 */
export function dockPeople(
  state: Pick<WorldState, "seed" | "jobs" | "actors">,
  content: ContentBundle,
  portId: PortDefId,
  plan: StagingPlan | undefined,
): LocalSpec[] {
  const people = floorSet(state, content, portId).map(floorSpec);
  for (const placement of plan?.place ?? []) {
    const spec = stagedSpec(content, portId, placement);
    if (spec === undefined) continue;
    const index = people.findIndex((p) => p.name.toLowerCase() === spec.name.toLowerCase());
    if (index < 0) {
      people.push(spec);
      continue;
    }
    const existing = people[index] as LocalSpec;
    people[index] = {
      ...existing,
      postKey: spec.postKey,
      ...(spec.label === undefined ? {} : { label: spec.label }),
    };
  }
  return people;
}

/** Place `spec` at its post on `dock` (or as near as there is room). Undefined if no room. */
export function placeLocal(
  state: WorldState,
  content: ContentBundle,
  presence: DockPresence,
  dock: DockDef,
  spec: LocalSpec,
  tick: Tick,
  shuffleTicks: number,
): Local | undefined {
  const post = dock.posts.find((p) => p.key === spec.postKey);
  if (post === undefined) return undefined;
  const reserved = reservedTiles(content, presence.deckId, dock, post.key);
  const tile = freeTileNear(dock, dockToDeck(dock, post.tile), localTiles(state), reserved);
  if (tile === undefined) return undefined;
  return spawnLocal(state, presence.deckId, spec, tile, postFacing(post), tick, shuffleTicks);
}

/** Set the plan's props down: on free staging tiles, or on free tiles beside their post. */
function placeProps(
  state: WorldState,
  content: ContentBundle,
  presence: DockPresence,
  dock: DockDef,
  plan: StagingPlan,
): DockProp[] {
  const props: DockProp[] = [];
  const taken = localTiles(state);
  for (const item of Object.values(state.items)) {
    const l = item.location;
    if (l.kind === "onDeck") taken.add(tileKey({ x: Math.floor(l.x), y: Math.floor(l.y) }));
  }
  const staging = dockAreaTiles(dock, "freightStaging");
  for (const prop of plan.props) {
    let tile: TileCoord | undefined;
    if (prop.at.kind === "staging") {
      tile = staging.find((t) => !taken.has(tileKey(t)));
    } else {
      const postKey = prop.at.postKey;
      const post = dock.posts.find((p) => p.key === postKey);
      if (post !== undefined) {
        const reserved = reservedTiles(content, presence.deckId, dock, undefined);
        // Every post's tile is reserved (it is its local's), so the prop lands beside it.
        tile = freeTileNear(dock, dockToDeck(dock, post.tile), taken, reserved);
      }
    }
    if (tile === undefined) continue;
    taken.add(tileKey(tile));
    props.push({ itemDefId: prop.itemDefId, count: prop.count, tile });
  }
  return props;
}

export interface DressedDock {
  readonly locals: readonly Local[];
  /** People the dock had no room for (logged by the caller). */
  readonly unplaced: readonly string[];
}

/**
 * Dress the dock alongside (`state.deck.dock`): the floor set, the staging plan's people and
 * props, its ambience line, recorded as dressed for that dock. Replaces whatever the slice held.
 * Throws with no dock alongside, or one content lost: the caller only dresses a dock it has.
 */
export function dressDock(
  state: WorldState,
  content: ContentBundle,
  plan: StagingPlan | undefined,
  tick: Tick,
  shuffleTicks: number,
): DressedDock {
  const presence = state.deck.dock;
  if (presence === undefined) throw new Error("dressDock: no dock is alongside");
  const dock = content.docks?.[presence.dockId];
  if (dock === undefined) throw new Error(`dressDock: no dock layout "${presence.dockId}"`);
  state.dockside = { dockId: dock.id, locals: {}, props: [] };
  const locals: Local[] = [];
  const unplaced: string[] = [];
  for (const spec of dockPeople(state, content, dock.portId, plan)) {
    const local = placeLocal(state, content, presence, dock, spec, tick, shuffleTicks);
    if (local === undefined) unplaced.push(spec.name);
    else locals.push(local);
  }
  if (plan !== undefined) {
    state.dockside.props = placeProps(state, content, presence, dock, plan);
    if (plan.ambience !== undefined) state.dockside.ambience = plan.ambience;
  }
  return { locals, unplaced };
}

/** Is the dock alongside (if any) not yet dressed? (A new game, or a save from schema 4.) */
export function dockNeedsDressing(state: Pick<WorldState, "deck" | "dockside">): boolean {
  const presence = state.deck.dock;
  return presence !== undefined && state.dockside.dockId !== presence.dockId;
}

/** The dock has gone: nobody and nothing of the slice outlives it. */
export function clearDockside(state: WorldState): void {
  state.dockside = { locals: {}, props: [] };
}
