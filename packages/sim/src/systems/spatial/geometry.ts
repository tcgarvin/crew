/**
 * Deck geometry cache (SD §6.2–6.4). Built from `DeckDef` + machine placements into
 * `caches.nav.decks`; rebuildable, never serialized.
 *
 * W0 decision 7: walls are implicit on every edge between two different compartments and between
 * floor and void; `openings` remove such a wall, `walls` add one inside a compartment, and a door
 * edge is neither wall nor open (crossing it needs a door check).
 */
import type { CacheBuilder } from "../../core/registry";
import type { EdgeSide, TileCoord, TileEdge } from "../../core/types/common";
import type { ContentBundle, DeckDef, MachineDef } from "../../core/types/content";
import type { CompartmentId, DeckDefId, DoorId, MachineId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { DeckGeometry, NavDoor, NavInteractionPosition } from "../../core/types/nav";
import type { DerivedCaches, ReadonlyWorldState } from "../../core/types/pipeline";
import { rebuildReservations } from "./reservations";

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

export function inBounds(geometry: DeckGeometry, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < geometry.width && y < geometry.height;
}

export function tileIndex(geometry: DeckGeometry, tile: TileCoord): number {
  return tile.y * geometry.width + tile.x;
}

/** Static floor that no machine stands on. */
export function isStaticWalkable(geometry: DeckGeometry, x: number, y: number): boolean {
  if (!inBounds(geometry, x, y)) return false;
  const i = y * geometry.width + x;
  return geometry.floor[i] === 1 && geometry.footprint[i] === 0;
}

/** Walkable right now: static walkable and not dynamically obstructed. */
export function isWalkable(geometry: DeckGeometry, x: number, y: number): boolean {
  return isStaticWalkable(geometry, x, y) && geometry.obstructed[y * geometry.width + x] === 0;
}

export function hasWall(geometry: DeckGeometry, tile: TileCoord, side: EdgeSide): boolean {
  if (!inBounds(geometry, tile.x, tile.y)) return true;
  return ((geometry.walls[tileIndex(geometry, tile)] ?? 0) & SIDE_BIT[side]) !== 0;
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
  if (!inBounds(geometry, tx, ty)) return undefined;
  const index = geometry.compartment[ty * geometry.width + tx] ?? -1;
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
}

/** Build the static geometry for one deck. Pure; `obstructed` starts clear. */
export function buildDeckGeometry(inputs: GeometryInputs): DeckGeometry {
  const { deck } = inputs;
  const { width, height } = deck;
  const size = width * height;
  const floor = new Uint8Array(size);
  const footprint = new Uint8Array(size);
  const compartment = new Int16Array(size).fill(-1);
  const walls = new Uint8Array(size);
  const doorSides = new Uint8Array(size);

  const compartmentIds: CompartmentId[] = [];
  const symbolIndex = new Map<string, number>();
  deck.compartments.forEach((def, index) => {
    symbolIndex.set(def.symbol, index);
    const id = inputs.compartmentIdByKey.get(def.key);
    if (id === undefined) throw new Error(`Deck "${deck.id}": no compartment "${def.key}"`);
    compartmentIds.push(id);
  });

  for (let y = 0; y < height; y++) {
    const row = deck.tiles[y] ?? "";
    for (let x = 0; x < width; x++) {
      const symbol = row[x] ?? " ";
      if (symbol === " ") continue;
      const index = symbolIndex.get(symbol);
      if (index === undefined) throw new Error(`Deck "${deck.id}": unknown symbol "${symbol}"`);
      floor[y * width + x] = 1;
      compartment[y * width + x] = index;
    }
  }

  const compartmentOf = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? -1 : (compartment[y * width + x] ?? -1);
  const setEdgeBits = (target: Uint8Array, edge: TileEdge, on: boolean) => {
    const delta = SIDE_DELTA[edge.side];
    const pairs: [number, number, EdgeSide][] = [
      [edge.x, edge.y, edge.side],
      [edge.x + delta.x, edge.y + delta.y, OPPOSITE[edge.side]],
    ];
    for (const [x, y, side] of pairs) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = y * width + x;
      target[i] = on ? (target[i] ?? 0) | SIDE_BIT[side] : (target[i] ?? 0) & ~SIDE_BIT[side];
    }
  };

  // Implicit walls: between floor and void/off-grid, and between different compartments.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = compartmentOf(x, y);
      if (here < 0) continue;
      for (const side of SIDES) {
        const d = SIDE_DELTA[side];
        if (compartmentOf(x + d.x, y + d.y) !== here) {
          walls[y * width + x] = (walls[y * width + x] ?? 0) | SIDE_BIT[side];
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
      if (x >= 0 && y >= 0 && x < width && y < height) footprint[y * width + x] = 1;
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
      const index = tile.y * width + tile.x;
      const list = interactionByTile.get(index);
      if (list === undefined) interactionByTile.set(index, [entry]);
      else list.push(entry);
    }
  }

  return {
    deckId: deck.id,
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
  };
}

/** Copy dynamic obstructions from `state.deck.tiles` into the geometry. */
export function refreshObstructions(geometry: DeckGeometry, state: ReadonlyWorldState): void {
  geometry.obstructed.fill(0);
  const tiles = state.deck.tiles[geometry.deckId] ?? {};
  for (const [key, tileState] of Object.entries(tiles)) {
    if (!tileState.obstructed) continue;
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (inBounds(geometry, x, y)) geometry.obstructed[y * geometry.width + x] = 1;
  }
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
  return {
    deck,
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

/** Rebuild every deck's geometry, the edge masks and the reservations from state + content. */
export function rebuildNav(
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
    refreshObstructions(geometry, state);
    nav.decks[deckId] = geometry;
    const mask = new Uint8Array(geometry.walls.length);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = (geometry.walls[i] ?? 0) | (geometry.doorSides[i] ?? 0);
    }
    nav.edgeMask[deckId] = mask;
  }
  nav.geometryRevision = state.deck.geometryRevision;
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
