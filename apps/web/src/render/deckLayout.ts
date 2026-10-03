/**
 * Static deck geometry for the canvas, derived once from the authored `DeckDef`
 * (`@crew/content`'s bundle) instead of the old hardcoded mock geometry (Integration 1, task item
 * 4). `DeckDef.tiles` is per-tile (a compact string grid), so the layout is per-tile too — simpler
 * and correct for non-rectangular compartments, at the cost of a few extra fill calls.
 */
import type {
  ContentBundle,
  DeckDef,
  LocalKey,
  MachineDefId,
  MachineTag,
  TileCoord,
  TileEdge,
} from "@crew/sim";
import { rotateOffset } from "@crew/sim";

export interface LayoutTile {
  readonly x: number;
  readonly y: number;
  /** `undefined` = void (non-navigable, not drawn as floor). */
  readonly compartmentKey: string | undefined;
}

interface LayoutDoorBase {
  readonly placementKey: LocalKey;
  readonly cx: number;
  readonly cy: number;
  readonly orientation: "horizontal" | "vertical";
}

export interface InteriorLayoutDoor extends LayoutDoorBase {
  readonly kind: "interior";
}

/**
 * Dockside §2.6 (D58): a ramp knows which one it is (the cargo ramp is a plate, the personnel
 * ramp a gangway) and which way is out of the hull, so it can be drawn extending.
 */
export interface RampLayoutDoor extends LayoutDoorBase {
  readonly kind: "ramp";
  readonly role: "cargo" | "personnel";
  /** Unit vector pointing out of the hull, in deck coordinates. */
  readonly out: { readonly x: number; readonly y: number };
}

export type LayoutDoor = InteriorLayoutDoor | RampLayoutDoor;

export interface LayoutMachine {
  readonly placementKey: LocalKey;
  readonly defId: MachineDefId;
  readonly name: string;
  /** D58: the def's tags, so the hull can find the engines for the plume. */
  readonly tags: readonly MachineTag[];
  readonly footprint: readonly TileCoord[];
  readonly center: { readonly x: number; readonly y: number };
}

/** Polish A: a wall edge in tile units, from (x1,y1) to (x2,y2); always one tile long. */
export interface WallSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** On the outside of the ship rather than between two compartments. */
  readonly hull: boolean;
}

export interface CompartmentBox {
  readonly minX: number;
  readonly minY: number;
  /** Exclusive. */
  readonly maxX: number;
  readonly maxY: number;
}

export interface DeckLayout {
  readonly deckId: DeckDef["id"];
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly LayoutTile[];
  readonly compartmentNames: Readonly<Record<string, string>>;
  readonly compartmentBounds: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /** Polish A: semantic tags per compartment (`cargoHold`, `galley`, …) for fills. */
  readonly compartmentTags: Readonly<Record<string, readonly string[]>>;
  /** Polish A: tile bounding box per compartment, for corner labels. */
  readonly compartmentBoxes: Readonly<Record<string, CompartmentBox>>;
  /** Polish A: walls along compartment and hull boundaries, minus doors and openings. */
  readonly walls: readonly WallSegment[];
  readonly doors: readonly LayoutDoor[];
  readonly machines: readonly LayoutMachine[];
}

function doorCentre(edge: TileEdge): {
  cx: number;
  cy: number;
  orientation: "horizontal" | "vertical";
} {
  switch (edge.side) {
    case "n":
      return { cx: edge.x + 0.5, cy: edge.y, orientation: "horizontal" };
    case "s":
      return { cx: edge.x + 0.5, cy: edge.y + 1, orientation: "horizontal" };
    case "w":
      return { cx: edge.x, cy: edge.y + 0.5, orientation: "vertical" };
    case "e":
      return { cx: edge.x + 1, cy: edge.y + 0.5, orientation: "vertical" };
  }
}

const OUTWARD: Readonly<Record<TileEdge["side"], { x: number; y: number }>> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
  e: { x: 1, y: 0 },
};

/** Canonical key for an edge, so `{x,y,n}` and `{x,y-1,s}` compare equal. */
export function edgeKey(edge: TileEdge): string {
  switch (edge.side) {
    case "n":
      return `${edge.x},${edge.y - 1},s`;
    case "w":
      return `${edge.x - 1},${edge.y},e`;
    default:
      return `${edge.x},${edge.y},${edge.side}`;
  }
}

function segmentFor(edge: TileEdge, hull: boolean): WallSegment {
  const { x, y } = edge;
  switch (edge.side) {
    case "n":
      return { x1: x, y1: y, x2: x + 1, y2: y, hull };
    case "s":
      return { x1: x, y1: y + 1, x2: x + 1, y2: y + 1, hull };
    case "w":
      return { x1: x, y1: y, x2: x, y2: y + 1, hull };
    case "e":
      return { x1: x + 1, y1: y, x2: x + 1, y2: y + 1, hull };
  }
}

/**
 * Walls: every tile edge whose two sides are different compartments (or floor and void/outside),
 * plus the authored interior walls, minus door apertures and doorless openings.
 */
function buildWalls(deck: DeckDef, keyAt: (x: number, y: number) => string | undefined) {
  const gaps = new Set([...deck.doors.map((d) => edgeKey(d.edge)), ...deck.openings.map(edgeKey)]);
  const seen = new Set<string>();
  const walls: WallSegment[] = [];
  const add = (edge: TileEdge, hull: boolean) => {
    const key = edgeKey(edge);
    if (gaps.has(key) || seen.has(key)) return;
    seen.add(key);
    walls.push(segmentFor(edge, hull));
  };
  const sides = [
    ["n", 0, -1],
    ["s", 0, 1],
    ["w", -1, 0],
    ["e", 1, 0],
  ] as const;
  for (let y = 0; y < deck.height; y++) {
    for (let x = 0; x < deck.width; x++) {
      const here = keyAt(x, y);
      if (here === undefined) continue;
      for (const [side, dx, dy] of sides) {
        const there = keyAt(x + dx, y + dy);
        if (there !== here) add({ x, y, side }, there === undefined);
      }
    }
  }
  for (const edge of deck.walls) add(edge, false);
  return walls;
}

/** Builds the canvas layout for one deck. Pure; safe to call once and cache on the main thread. */
export function buildDeckLayout(deck: DeckDef, content: ContentBundle): DeckLayout {
  const symbolToKey = new Map(deck.compartments.map((c) => [c.symbol, c.key] as const));
  const compartmentNames: Record<string, string> = {};
  for (const c of deck.compartments) compartmentNames[c.key] = c.name;

  const tiles: LayoutTile[] = [];
  const compartmentBounds: Record<string, { x: number; y: number }> = {};
  for (let y = 0; y < deck.height; y++) {
    const row = deck.tiles[y] ?? "";
    for (let x = 0; x < deck.width; x++) {
      const symbol = row[x] ?? " ";
      const compartmentKey = symbol === " " ? undefined : symbolToKey.get(symbol);
      tiles.push({ x, y, compartmentKey });
      if (compartmentKey !== undefined) {
        const bound = compartmentBounds[compartmentKey];
        if (bound === undefined || y < bound.y || (y === bound.y && x < bound.x)) {
          compartmentBounds[compartmentKey] = { x, y };
        }
      }
    }
  }

  const keyAt = (x: number, y: number): string | undefined => {
    if (x < 0 || y < 0 || x >= deck.width || y >= deck.height) return undefined;
    return tiles[y * deck.width + x]?.compartmentKey;
  };
  const compartmentTags: Record<string, readonly string[]> = {};
  for (const c of deck.compartments) compartmentTags[c.key] = c.tags;
  const compartmentBoxes: Record<string, CompartmentBox> = {};
  for (const tile of tiles) {
    if (tile.compartmentKey === undefined) continue;
    const box = compartmentBoxes[tile.compartmentKey];
    compartmentBoxes[tile.compartmentKey] =
      box === undefined
        ? { minX: tile.x, minY: tile.y, maxX: tile.x + 1, maxY: tile.y + 1 }
        : {
            minX: Math.min(box.minX, tile.x),
            minY: Math.min(box.minY, tile.y),
            maxX: Math.max(box.maxX, tile.x + 1),
            maxY: Math.max(box.maxY, tile.y + 1),
          };
  }

  const doors: LayoutDoor[] = deck.doors.map((d) => {
    const { cx, cy, orientation } = doorCentre(d.edge);
    if (d.kind === "interior") return { placementKey: d.key, kind: d.kind, cx, cy, orientation };
    const role = d.key === deck.docking.personnelRampDoorKey ? "personnel" : "cargo";
    return {
      placementKey: d.key,
      kind: d.kind,
      role,
      out: OUTWARD[d.edge.side],
      cx,
      cy,
      orientation,
    };
  });

  const machines: LayoutMachine[] = deck.machines.map((placement) => {
    const def = content.machines[placement.machineDefId];
    const footprintOffsets = def?.footprint ?? [{ x: 0, y: 0 }];
    const footprint = footprintOffsets.map((offset) => {
      const rotated = rotateOffset(offset, placement.rotation);
      return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
    });
    const cx = footprint.reduce((sum, t) => sum + t.x + 0.5, 0) / footprint.length;
    const cy = footprint.reduce((sum, t) => sum + t.y + 0.5, 0) / footprint.length;
    return {
      placementKey: placement.key,
      defId: placement.machineDefId,
      name: def?.name ?? placement.machineDefId,
      tags: def?.tags ?? [],
      footprint,
      center: { x: cx, y: cy },
    };
  });

  return {
    deckId: deck.id,
    width: deck.width,
    height: deck.height,
    tiles,
    compartmentNames,
    compartmentBounds,
    compartmentTags,
    compartmentBoxes,
    walls: buildWalls(deck, keyAt),
    doors,
    machines,
  };
}
