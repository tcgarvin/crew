/**
 * Deck geometry cache (SD §6.2–6.4). Built from `DeckDef` + machine placements into
 * `caches.nav.decks`; rebuildable, never serialized.
 *
 * W0 decision 7: walls are implicit on every edge between two different compartments and between
 * floor and void; `openings` remove such a wall, `walls` add one inside a compartment, and a door
 * edge is neither wall nor open (crossing it needs a door check).
 *
 * Dockside spike (docs/design/dockside-spike.md): while a dock is alongside (`state.deck.dock`),
 * its floor is grafted into the deck's grid in the deck's own frame (deck tile = dock tile −
 * shipAt), as floor in no compartment. Dock floor is a region of its own for implicit walls, so
 * the hull walls it off from the ship everywhere except across the ramp doors. The grid then has
 * a non-zero origin and larger bounds; every index goes through `indexAt`/`tileAtIndex`.
 */
import type { CacheBuilder } from "../../core/registry";
import type { EdgeSide, TileCoord, TileEdge } from "../../core/types/common";
import type { ContentBundle, DeckDef, DockDef, MachineDef } from "../../core/types/content";
import type { CompartmentId, DeckDefId, DockDefId, DoorId, MachineId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import {
  DOCK_FLOOR,
  type DeckGeometry,
  type NavDockGraft,
  type NavDoor,
  type NavInteractionPosition,
} from "../../core/types/nav";
import type { DerivedCaches, ReadonlyWorldState } from "../../core/types/pipeline";
import type { DockPresence, Door } from "../../core/types/ship";
import type { WorldState } from "../../core/types/state";
import { type Grid, inBounds, indexAt, tileIndex } from "./grid";
import { rebuildReservations } from "./reservations";

export { inBounds, indexAt, tileAtIndex, tileIndex } from "./grid";

export const SIDE_BIT: Readonly<Record<EdgeSide, number>> = { n: 1, e: 2, s: 4, w: 8 };

const SIDE_DELTA: Readonly<Record<EdgeSide, TileCoord>> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

const OPPOSITE: Readonly<Record<EdgeSide, EdgeSide>> = { n: "s", e: "w", s: "n", w: "e" };

export const SIDES: readonly EdgeSide[] = ["n", "e", "s", "w"];

/** Canonical key for an edge shared by two tiles: `h` edges run along the top of a tile, `v` along its left. */
export function edgeKey(edge: TileEdge): string {
  switch (edge.side) {
    case "n":
      return `h${edge.x},${edge.y}`;
    case "s":
      return `h${edge.x},${edge.y + 1}`;
    case "w":
      return `v${edge.x},${edge.y}`;
    case "e":
      return `v${edge.x + 1},${edge.y}`;
  }
}

/** The side of `from` that faces the orthogonally adjacent `to`, or undefined if not adjacent. */
export function sideTowards(from: TileCoord, to: TileCoord): EdgeSide | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === -1) return "n";
  if (dx === 1 && dy === 0) return "e";
  if (dx === 0 && dy === 1) return "s";
  if (dx === -1 && dy === 0) return "w";
  return undefined;
}

/** Static floor that no machine stands on. */
/**
 * Grid index of tile (x, y), or -1 off the grid. Same arithmetic as `grid.ts`, kept local
 * because these predicates are pathfinding's innermost calls and a cross-module call costs a
 * binding lookup per call under the test runner's module transform (measurable in fullSim).
 */
function cell(geometry: Grid, x: number, y: number): number {
  const gx = x - geometry.originX;
  const gy = y - geometry.originY;
  if (gx < 0 || gy < 0 || gx >= geometry.width || gy >= geometry.height) return -1;
  return gy * geometry.width + gx;
}

export function isStaticWalkable(geometry: DeckGeometry, x: number, y: number): boolean {
  const i = cell(geometry, x, y);
  return i >= 0 && geometry.floor[i] === 1 && geometry.footprint[i] === 0;
}

/** Walkable right now: static walkable and not dynamically obstructed. */
export function isWalkable(geometry: DeckGeometry, x: number, y: number): boolean {
  const i = cell(geometry, x, y);
  return (
    i >= 0 && geometry.floor[i] === 1 && geometry.footprint[i] === 0 && geometry.obstructed[i] === 0
  );
}

/** Is the tile under this point floor (the ship's or a grafted dock's), machines or not? */
export function isStaticFloor(geometry: DeckGeometry, x: number, y: number): boolean {
  const i = cell(geometry, Math.floor(x), Math.floor(y));
  return i >= 0 && geometry.floor[i] === 1;
}

/** Is the tile under this point grafted dock floor (rather than the ship's own floor)? */
export function isDockTile(geometry: DeckGeometry, x: number, y: number): boolean {
  const i = cell(geometry, Math.floor(x), Math.floor(y));
  return i >= 0 && geometry.compartment[i] === DOCK_FLOOR;
}

export function hasWall(geometry: DeckGeometry, tile: TileCoord, side: EdgeSide): boolean {
  const i = cell(geometry, tile.x, tile.y);
  if (i < 0) return true;
  return ((geometry.walls[i] ?? 0) & SIDE_BIT[side]) !== 0;
}

export function doorOnEdge(
  geometry: DeckGeometry,
  tile: TileCoord,
  side: EdgeSide,
): DoorId | undefined {
  return geometry.doorByEdge.get(edgeKey({ x: tile.x, y: tile.y, side }));
}

/** Door crossed by an orthogonal step from `a` to `b`, if any. */
export function doorBetween(
  geometry: DeckGeometry,
  a: TileCoord,
  b: TileCoord,
): DoorId | undefined {
  const side = sideTowards(a, b);
  return side === undefined ? undefined : doorOnEdge(geometry, a, side);
}

export function compartmentAt(
  geometry: DeckGeometry,
  x: number,
  y: number,
): CompartmentId | undefined {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const i = cell(geometry, tx, ty);
  if (i < 0) return undefined;
  const index = geometry.compartment[i] ?? -1;
  return index < 0 ? undefined : geometry.compartmentIds[index];
}

/** Rotate a footprint offset clockwise (x east, y south). */
export function rotateOffset(offset: TileCoord, rotation: 0 | 90 | 180 | 270): TileCoord {
  switch (rotation) {
    case 0:
      return offset;
    case 90:
      return { x: -offset.y + 0, y: offset.x + 0 };
    case 180:
      return { x: -offset.x + 0, y: -offset.y + 0 };
    case 270:
      return { x: offset.y + 0, y: -offset.x + 0 };
  }
}

export interface GeometryInputs {
  readonly deck: DeckDef;
  readonly machineDefs: (id: MachineDef["id"]) => MachineDef | undefined;
  /** Compartment instance by `CompartmentDef.key`. */
  readonly compartmentIdByKey: ReadonlyMap<string, CompartmentId>;
  /** Door instance by placement key. */
  readonly doorIdByKey: ReadonlyMap<string, DoorId>;
  /** Machine instance by placement key. */
  readonly machineIdByKey: ReadonlyMap<string, MachineId>;
  /** The dock to graft onto this deck, if one is alongside. */
  readonly dock?: DockDef;
}

const floorMasks = new WeakMap<DockDef, Uint8Array>();

/**
 * Walkable dock floor, row-major in the dock's own frame (`y * width + x`): a `floor` tile under
 * no blocking prop. Content validation applies the same rule (`packages/content`
 * `dockWalkableMask`); a CLI test holds the two together. Memoized per def (defs are immutable).
 * Throws on a malformed map, which content validation makes impossible for authored docks.
 */
export function dockFloorMask(dock: DockDef): Uint8Array {
  const cached = floorMasks.get(dock);
  if (cached !== undefined) return cached;
  if (dock.rows.length !== dock.height) {
    throw new Error(`Dock "${dock.id}": ${dock.rows.length} rows, expected ${dock.height}`);
  }
  const mask = new Uint8Array(dock.width * dock.height);
  dock.rows.forEach((row, y) => {
    if (row.length !== dock.width) {
      throw new Error(`Dock "${dock.id}": row ${y} is ${row.length} wide, expected ${dock.width}`);
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? "";
      const kind = dock.legend[ch];
      if (kind === undefined) throw new Error(`Dock "${dock.id}": "${ch}" is not in the legend`);
      if (kind === "floor") mask[y * dock.width + x] = 1;
    }
  });
  for (const prop of dock.props) {
    if (!prop.blocking) continue;
    const { x: px, y: py, w, h } = prop.rect;
    for (let y = py; y < py + h; y++) {
      for (let x = px; x < px + w; x++) {
        if (x < 0 || y < 0 || x >= dock.width || y >= dock.height) {
          throw new Error(`Dock "${dock.id}": prop "${prop.key}" reaches off the map`);
        }
        mask[y * dock.width + x] = 0;
      }
    }
  }
  floorMasks.set(dock, mask);
  return mask;
}

/** Is dock-frame tile (x, y) walkable dock floor? False off the map. */
export function isDockFloor(dock: DockDef, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= dock.width || y >= dock.height) return false;
  return dockFloorMask(dock)[y * dock.width + x] === 1;
}

/** Deck-frame tiles of a dock's walkable floor. Throws on a malformed map. */
export function dockFloorTiles(dock: DockDef): TileCoord[] {
  const mask = dockFloorMask(dock);
  const tiles: TileCoord[] = [];
  for (let y = 0; y < dock.height; y++) {
    for (let x = 0; x < dock.width; x++) {
      if (mask[y * dock.width + x] === 1) {
        tiles.push({ x: x - dock.shipAt.x, y: y - dock.shipAt.y });
      }
    }
  }
  return tiles;
}

/** Bounds of the deck plus, if docked, the dock map (both in deck coordinates). */
function gridBounds(deck: DeckDef, dock: DockDef | undefined): Grid {
  if (dock === undefined) return { originX: 0, originY: 0, width: deck.width, height: deck.height };
  const originX = Math.min(0, -dock.shipAt.x);
  const originY = Math.min(0, -dock.shipAt.y);
  const endX = Math.max(deck.width, dock.width - dock.shipAt.x);
  const endY = Math.max(deck.height, dock.height - dock.shipAt.y);
  return { originX, originY, width: endX - originX, height: endY - originY };
}

/** Build the static geometry for one deck and any grafted dock. Pure; dynamic state starts clear. */
export function buildDeckGeometry(inputs: GeometryInputs): DeckGeometry {
  const { deck, dock } = inputs;
  const grid = gridBounds(deck, dock);
  const { originX, originY, width, height } = grid;
  const size = width * height;
  const floor = new Uint8Array(size);
  const footprint = new Uint8Array(size);
  const compartment = new Int16Array(size).fill(-1);
  const walls = new Uint8Array(size);
  const doorSides = new Uint8Array(size);
  const inGrid = (x: number, y: number) => inBounds(grid, x, y);
  const at = (x: number, y: number) => indexAt(grid, x, y);

  const compartmentIds: CompartmentId[] = [];
  const symbolIndex = new Map<string, number>();
  deck.compartments.forEach((def, index) => {
    symbolIndex.set(def.symbol, index);
    const id = inputs.compartmentIdByKey.get(def.key);
    if (id === undefined) throw new Error(`Deck "${deck.id}": no compartment "${def.key}"`);
    compartmentIds.push(id);
  });

  for (let y = 0; y < deck.height; y++) {
    const row = deck.tiles[y] ?? "";
    for (let x = 0; x < deck.width; x++) {
      const symbol = row[x] ?? " ";
      if (symbol === " ") continue;
      const index = symbolIndex.get(symbol);
      if (index === undefined) throw new Error(`Deck "${deck.id}": unknown symbol "${symbol}"`);
      floor[at(x, y)] = 1;
      compartment[at(x, y)] = index;
    }
  }
  if (dock !== undefined) {
    for (const tile of dockFloorTiles(dock)) {
      const i = at(tile.x, tile.y);
      if (floor[i] === 1) {
        throw new Error(
          `Dock "${dock.id}": floor at deck (${tile.x},${tile.y}) overlaps deck "${deck.id}"`,
        );
      }
      floor[i] = 1;
      compartment[i] = DOCK_FLOOR;
    }
  }

  // Void and off-grid are both -1, so the grid's outer edge is walled too.
  const regionOf = (x: number, y: number): number =>
    inGrid(x, y) ? (compartment[at(x, y)] ?? -1) : -1;
  const setEdgeBits = (target: Uint8Array, edge: TileEdge, on: boolean) => {
    const delta = SIDE_DELTA[edge.side];
    const pairs: [number, number, EdgeSide][] = [
      [edge.x, edge.y, edge.side],
      [edge.x + delta.x, edge.y + delta.y, OPPOSITE[edge.side]],
    ];
    for (const [x, y, side] of pairs) {
      if (!inGrid(x, y)) continue;
      const i = at(x, y);
      target[i] = on ? (target[i] ?? 0) | SIDE_BIT[side] : (target[i] ?? 0) & ~SIDE_BIT[side];
    }
  };

  // Implicit walls: between floor and void/off-grid, between different compartments, and between
  // the ship and grafted dock floor (the hull), on both tiles of each edge.
  for (let y = originY; y < originY + height; y++) {
    for (let x = originX; x < originX + width; x++) {
      const here = regionOf(x, y);
      if (here === -1) continue;
      for (const side of SIDES) {
        const d = SIDE_DELTA[side];
        if (regionOf(x + d.x, y + d.y) !== here) {
          walls[at(x, y)] = (walls[at(x, y)] ?? 0) | SIDE_BIT[side];
        }
      }
    }
  }
  for (const edge of deck.walls) setEdgeBits(walls, edge, true);
  for (const edge of deck.openings) setEdgeBits(walls, edge, false);

  const doorByEdge = new Map<string, DoorId>();
  const doors = new Map<DoorId, NavDoor>();
  for (const placement of deck.doors) {
    const id = inputs.doorIdByKey.get(placement.key);
    if (id === undefined) throw new Error(`Deck "${deck.id}": no door "${placement.key}"`);
    setEdgeBits(walls, placement.edge, false);
    setEdgeBits(doorSides, placement.edge, true);
    doorByEdge.set(edgeKey(placement.edge), id);
    const d = SIDE_DELTA[placement.edge.side];
    doors.set(id, {
      id,
      placement,
      edge: placement.edge,
      tiles: [
        { x: placement.edge.x, y: placement.edge.y },
        { x: placement.edge.x + d.x, y: placement.edge.y + d.y },
      ],
    });
  }

  const interactionPositions: NavInteractionPosition[] = [];
  const interactionByTile = new Map<number, NavInteractionPosition[]>();
  for (const placement of deck.machines) {
    const def = inputs.machineDefs(placement.machineDefId);
    const machineId = inputs.machineIdByKey.get(placement.key);
    if (def === undefined || machineId === undefined) continue;
    for (const offset of def.footprint) {
      const r = rotateOffset(offset, placement.rotation);
      const x = placement.origin.x + r.x;
      const y = placement.origin.y + r.y;
      if (inGrid(x, y)) footprint[at(x, y)] = 1;
    }
    for (const position of def.interactionPositions) {
      const r = rotateOffset(position.offset, placement.rotation);
      const tile = { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
      const entry: NavInteractionPosition = {
        machineId,
        key: position.key,
        tile,
        purposes: position.purposes,
        capacity: position.capacity,
      };
      interactionPositions.push(entry);
      const index = at(tile.x, tile.y);
      const list = interactionByTile.get(index);
      if (list === undefined) interactionByTile.set(index, [entry]);
      else list.push(entry);
    }
  }

  const geometry: DeckGeometry = {
    deckId: deck.id,
    originX,
    originY,
    width,
    height,
    floor,
    footprint,
    obstructed: new Uint8Array(size),
    compartment,
    compartmentIds,
    walls,
    doorSides,
    doorByEdge,
    doors,
    interactionPositions,
    interactionByTile,
    openRamps: new Set(),
  };
  return dock === undefined ? geometry : { ...geometry, dock: dockGraft(geometry, dock) };
}

/** Where each ramp lands on the dock; throws if a ramp would open onto anything but dock floor. */
function dockGraft(geometry: DeckGeometry, dock: DockDef): NavDockGraft {
  const landings = new Map<DoorId, TileCoord>();
  for (const nav of geometry.doors.values()) {
    if (nav.placement.kind !== "ramp") continue;
    const outside = nav.tiles.find((t) => isDockTile(geometry, t.x, t.y));
    if (outside === undefined) {
      throw new Error(
        `Dock "${dock.id}": ramp "${nav.placement.key}" does not open onto dock floor`,
      );
    }
    landings.set(nav.id, outside);
  }
  return { dockId: dock.id, offset: { x: -dock.shipAt.x, y: -dock.shipAt.y }, landings };
}

/** Copy dynamic state into the geometry: obstructions from `state.deck.tiles`, and open ramps. */
export function refreshDynamic(geometry: DeckGeometry, state: ReadonlyWorldState): void {
  geometry.obstructed.fill(0);
  const tiles = state.deck.tiles[geometry.deckId] ?? {};
  for (const [key, tileState] of Object.entries(tiles)) {
    if (!tileState.obstructed) continue;
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (inBounds(geometry, x, y)) geometry.obstructed[indexAt(geometry, x, y)] = 1;
  }
  geometry.openRamps.clear();
  for (const nav of geometry.doors.values()) {
    const door = state.doors[nav.id];
    if (nav.placement.kind === "ramp" && door !== undefined && rampPassable(door)) {
      geometry.openRamps.add(nav.id);
    }
  }
}

/**
 * Planning may route across a ramp only while it is fully open and travel still wants it open:
 * once travel asks for the ramps up, nobody sets off down one. Ramp requests are as public as
 * ramp state.
 */
export function rampPassable(door: Pick<Door, "physicalState" | "requestedState">): boolean {
  return door.physicalState === "open" && door.requestedState === "open";
}

/**
 * Bring every deck's `openRamps` in line with the doors; on any change, bump the geometry
 * revision (cached routes keyed by it miss) and flag navigation dirty. Called by the door system
 * every run and by whoever changes a ramp request (travel), so planning sees it the same tick.
 */
export function syncRampPassability(
  state: { readonly doors: WorldState["doors"]; readonly deck: WorldState["deck"] },
  caches: DerivedCaches,
): void {
  let changed = false;
  for (const geometry of Object.values(caches.nav.decks)) {
    for (const nav of geometry.doors.values()) {
      if (nav.placement.kind !== "ramp") continue;
      const door = state.doors[nav.id];
      const passable = door !== undefined && rampPassable(door);
      if (passable === geometry.openRamps.has(nav.id)) continue;
      if (passable) geometry.openRamps.add(nav.id);
      else geometry.openRamps.delete(nav.id);
      changed = true;
    }
  }
  if (!changed) return;
  state.deck.geometryRevision += 1;
  // Drop cached routes now: not every policy key carries the revision (`schematic` does not).
  caches.nav.paths.clear();
  caches.dirty.navigation = true;
}

/** The dock map grafted onto `deckId` in this state, if any; throws if content lacks it. */
export function dockLayoutFor(
  content: ContentBundle,
  state: ReadonlyWorldState,
  deckId: DeckDefId,
): DockDef | undefined {
  const presence = state.deck.dock;
  if (presence === undefined || presence.deckId !== deckId) return undefined;
  const layout = content.docks?.[presence.dockId];
  if (layout === undefined) throw new Error(`No dock layout "${presence.dockId}" in content`);
  return layout;
}

/**
 * Build (and discard) the geometry `presence` would produce, so a bad graft throws before any
 * state changes: unknown deck or layout, dock floor over the ship, a ramp landing on nothing.
 */
export function checkDockGraft(
  content: ContentBundle,
  state: ReadonlyWorldState,
  presence: DockPresence,
): void {
  const deck = content.decks[presence.deckId];
  if (deck === undefined) throw new Error(`No deck "${presence.deckId}" to dock against`);
  const layout = content.docks?.[presence.dockId];
  if (layout === undefined) throw new Error(`No dock layout "${presence.dockId}" in content`);
  buildDeckGeometry({ ...geometryInputs(deck, content, state), dock: layout });
}

/**
 * The same check with no world, for content validation (`crew content validate`): graft the dock
 * onto the bare deck def and throw as `attachDock` would. Instance ids are stood in by placement
 * keys, which is all the builder uses them for.
 */
export function checkDockFitsDeck(
  content: ContentBundle,
  deckId: DeckDefId,
  dockId: DockDefId,
): void {
  const deck = content.decks[deckId];
  if (deck === undefined) throw new Error(`No deck "${deckId}" to dock against`);
  const dock = content.docks?.[dockId];
  if (dock === undefined) throw new Error(`No dock "${dockId}" in content`);
  const byKey = <I>(keys: readonly { key: string }[]) =>
    new Map(keys.map((k) => [k.key, k.key as unknown as I]));
  buildDeckGeometry({
    deck,
    dock,
    machineDefs: (id) => content.machines[id],
    compartmentIdByKey: byKey<CompartmentId>(deck.compartments),
    doorIdByKey: byKey<DoorId>(deck.doors),
    machineIdByKey: byKey<MachineId>(deck.machines),
  });
}

function geometryInputs(
  deck: DeckDef,
  content: ContentBundle,
  state: ReadonlyWorldState,
): GeometryInputs {
  const byKey = <T extends { deckId: DeckDefId }, I>(
    rows: Readonly<Record<string, T>>,
    key: (row: T) => string,
    id: (row: T) => I,
  ) => {
    const map = new Map<string, I>();
    for (const row of Object.values(rows)) {
      if (row.deckId === deck.id) map.set(key(row), id(row));
    }
    return map;
  };
  const dock = dockLayoutFor(content, state, deck.id);
  return {
    deck,
    ...(dock === undefined ? {} : { dock }),
    machineDefs: (id) => content.machines[id],
    compartmentIdByKey: byKey(
      state.compartments,
      (c) => c.key,
      (c) => c.id,
    ),
    doorIdByKey: byKey(
      state.doors,
      (d) => d.placementKey,
      (d) => d.id,
    ),
    machineIdByKey: byKey(
      state.machines,
      (m) => m.placementKey,
      (m) => m.id,
    ),
  };
}

/** Rebuild every deck's geometry (with any grafted dock) and edge mask; drops cached paths. */
export function rebuildGeometries(
  caches: DerivedCaches,
  content: ContentBundle,
  state: ReadonlyWorldState,
): void {
  const nav = caches.nav;
  nav.decks = {};
  nav.edgeMask = {};
  nav.paths.clear();
  for (const deckId of Object.keys(state.deck.tiles) as DeckDefId[]) {
    const deck = content.decks[deckId];
    if (deck === undefined) continue;
    const geometry = buildDeckGeometry(geometryInputs(deck, content, state));
    refreshDynamic(geometry, state);
    nav.decks[deckId] = geometry;
    const mask = new Uint8Array(geometry.walls.length);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = (geometry.walls[i] ?? 0) | (geometry.doorSides[i] ?? 0);
    }
    nav.edgeMask[deckId] = mask;
  }
  nav.geometryRevision = state.deck.geometryRevision;
}

/** Does every cached deck geometry graft exactly the dock the state says is alongside? */
export function dockGraftCurrent(caches: DerivedCaches, state: ReadonlyWorldState): boolean {
  const presence = state.deck.dock;
  return Object.values(caches.nav.decks).every((geometry) => {
    const wanted = presence?.deckId === geometry.deckId ? presence.dockId : undefined;
    return geometry.dock?.dockId === wanted;
  });
}

/** Rebuild every deck's geometry, the edge masks and the reservations from state + content. */
export function rebuildNav(
  caches: DerivedCaches,
  content: ContentBundle,
  state: ReadonlyWorldState,
): void {
  rebuildGeometries(caches, content, state);
  rebuildReservations(caches, state);
}

/** Registered with `registerCacheBuilder`; runs on `createWorld` and `restore`. */
export const navCacheBuilder: CacheBuilder = {
  name: "spatial.nav",
  build(world: World) {
    rebuildNav(world.caches, world.content, world.state);
  },
};

/** Geometry for a deck, or throw: a missing deck is a setup bug. */
export function deckGeometry(caches: DerivedCaches, deckId: DeckDefId): DeckGeometry {
  const geometry = caches.nav.decks[deckId];
  if (geometry === undefined) {
    throw new Error(`No navigation geometry for deck "${deckId}" (nav cache not built?)`);
  }
  return geometry;
}
