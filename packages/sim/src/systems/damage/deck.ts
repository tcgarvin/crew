/**
 * Where damage work stands, read from content alone (task derivation has no geometry cache): the
 * deck's open floor (authored tiles no machine stands on), the tiles beside a scar, a
 * compartment's door tiles, and a machine's interaction tiles.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { DeepReadonly, EdgeSide, TileCoord } from "../../core/types/common";
import type { ContentBundle, DeckDef, MachinePlacementDef } from "../../core/types/content";
import { rotateOffset } from "../spatial/geometry";

type Deck = DeepReadonly<DeckDef>;
type Content = Pick<ContentBundle, "machines">;

const keyOf = (x: number, y: number): string => `${x},${y}`;

/** Chebyshev distance: a step in any of the eight directions is one. */
export const chebyshev = (a: TileCoord, b: TileCoord): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const footprints = new WeakMap<Deck, ReadonlySet<string>>();

/** Every tile some machine's footprint covers (cached per deck def). */
function machineFootprint(content: Content, deck: Deck): ReadonlySet<string> {
  const cached = footprints.get(deck);
  if (cached !== undefined) return cached;
  const covered = new Set<string>();
  for (const placement of deck.machines) {
    for (const tile of placementFootprint(content, placement)) covered.add(keyOf(tile.x, tile.y));
  }
  footprints.set(deck, covered);
  return covered;
}

/** The absolute tiles a placed machine covers. */
export function placementFootprint(
  content: Content,
  placement: DeepReadonly<MachinePlacementDef>,
): TileCoord[] {
  const def = content.machines[placement.machineDefId];
  return (def?.footprint ?? []).map((offset) => {
    const r = rotateOffset(offset, placement.rotation);
    return { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
  });
}

/** The compartment symbol of an authored tile, or undefined off the deck or on void. */
export function symbolAt(deck: Deck, tile: TileCoord): string | undefined {
  const char = deck.tiles[tile.y]?.charAt(tile.x);
  return char === undefined || char === "" || char === " " ? undefined : char;
}

/** Authored floor that no machine stands on. */
export function isOpenFloor(content: Content, deck: Deck, tile: TileCoord): boolean {
  return (
    symbolAt(deck, tile) !== undefined &&
    !machineFootprint(content, deck).has(keyOf(tile.x, tile.y))
  );
}

/** Every open floor tile of the compartment with this symbol, row-major. */
export function compartmentFloor(content: Content, deck: Deck, symbol: string): TileCoord[] {
  const out: TileCoord[] = [];
  deck.tiles.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row.charAt(x) === symbol && isOpenFloor(content, deck, { x, y })) out.push({ x, y });
    }
  });
  return out;
}

/** The compartment symbol for a compartment key on this deck. */
export function symbolOf(deck: Deck, key: string): string | undefined {
  return deck.compartments.find((c) => c.key === key)?.symbol;
}

/**
 * Where to stand to work on the hull at `centre`: the centre and its eight neighbours that are
 * open floor in the same compartment, nearest first (the centre itself when it is floor); or, when
 * machines cover all of them, the compartment's open floor nearest the centre.
 */
export function besideTiles(content: Content, deck: Deck, centre: TileCoord): TileCoord[] {
  const symbol = symbolAt(deck, centre);
  if (symbol === undefined) return [];
  const near: TileCoord[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tile = { x: centre.x + dx, y: centre.y + dy };
      if (symbolAt(deck, tile) === symbol && isOpenFloor(content, deck, tile)) near.push(tile);
    }
  }
  const pool = near.length > 0 ? near : compartmentFloor(content, deck, symbol);
  return pool.sort((a, b) => chebyshev(a, centre) - chebyshev(b, centre) || a.y - b.y || a.x - b.x);
}

const ACROSS: Readonly<Record<EdgeSide, TileCoord>> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

/**
 * The compartment's open floor tiles that lie on one of its doors or openings (either side of the
 * edge), in authored order; or, for a room with none, its first open floor tile.
 */
export function doorTiles(content: Content, deck: Deck, symbol: string): TileCoord[] {
  const out: TileCoord[] = [];
  const seen = new Set<string>();
  const take = (tile: TileCoord): void => {
    const key = keyOf(tile.x, tile.y);
    if (seen.has(key) || symbolAt(deck, tile) !== symbol) return;
    if (!isOpenFloor(content, deck, tile)) return;
    seen.add(key);
    out.push(tile);
  };
  for (const edge of [...deck.doors.map((d) => d.edge), ...deck.openings]) {
    const step = ACROSS[edge.side];
    take({ x: edge.x, y: edge.y });
    take({ x: edge.x + step.x, y: edge.y + step.y });
  }
  if (out.length > 0) return out;
  const first = compartmentFloor(content, deck, symbol)[0];
  return first === undefined ? [] : [first];
}

/**
 * The tiles to stand on to work a placed machine: its `repair` positions, else any position,
 * else the open floor around its footprint.
 */
export function machineWorkTiles(
  content: Content,
  deck: Deck,
  placement: DeepReadonly<MachinePlacementDef>,
): TileCoord[] {
  const def = content.machines[placement.machineDefId];
  if (def === undefined) return [];
  const at = (offset: TileCoord): TileCoord => {
    const r = rotateOffset(offset, placement.rotation);
    return { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
  };
  const repair = def.interactionPositions.filter((p) => p.purposes.includes("repair"));
  const positions = repair.length > 0 ? repair : def.interactionPositions;
  if (positions.length > 0) return positions.map((p) => at(p.offset));
  const footprint = placementFootprint(content, placement);
  const around: TileCoord[] = [];
  const seen = new Set<string>();
  for (const tile of footprint) {
    for (const step of Object.values(ACROSS)) {
      const next = { x: tile.x + step.x, y: tile.y + step.y };
      const key = keyOf(next.x, next.y);
      if (seen.has(key) || !isOpenFloor(content, deck, next)) continue;
      seen.add(key);
      around.push(next);
    }
  }
  return around;
}
