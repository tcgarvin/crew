/**
 * Room dirt and tiers (D82), and the quantised arithmetic every dirt source shares.
 *
 * `roomDirt = (1 − roomMaxWeight) × mean + roomMaxWeight × max` over the room's cells
 * (`core/dirt-grid.ts` `roomCells`), as a share of 1.0. Cells under a machine never take dirt
 * (`dirtFloor`), so they only dilute the mean a little; they are kept in the room so the renderer
 * and the inspector read the same cells as the tier does. `tierOf` applies `dirt.tiers.{untidy,
 * dirty, filthy}` rising and `tierHysteresis` falling, against the room's stored tier.
 *
 * Owner: W2 of ship life slice 3.
 */
import { cellIndex, inGrid, roomCells } from "../../core/dirt-grid";
import type { TileCoord } from "../../core/types/common";
import type { ConfigDef, ContentBundle, DeckDef, DirtTier } from "../../core/types/content";
import type { LocalKey } from "../../core/types/ids";
import { rotateOffset } from "../spatial/geometry";

/** A cell's full scale: 255 is 1.0 of dirt. */
export const CELL_MAX = 255;

/** `cell` plus `units` (of `CELL_MAX`), rounded and clamped to the cell's range. */
export function addUnits(cell: number, units: number): number {
  return Math.min(CELL_MAX, Math.max(0, Math.round(cell + units)));
}

const TIER_RANK: Readonly<Record<DirtTier, number>> = { clean: 0, untidy: 1, dirty: 2, filthy: 3 };

/** Order of the tiers, clean lowest. */
export function tierRank(tier: DirtTier): number {
  return TIER_RANK[tier];
}

/** Room dirt at which `tier` begins (0 for `clean`). */
function threshold(tier: DirtTier, config: Pick<ConfigDef, "dirt">): number {
  return tier === "clean" ? 0 : config.dirt.tiers[tier];
}

const BELOW: Readonly<Record<DirtTier, DirtTier>> = {
  clean: "clean",
  untidy: "clean",
  dirty: "untidy",
  filthy: "dirty",
};

export function roomDirt(
  cells: readonly number[],
  deck: DeckDef,
  compartmentKey: LocalKey,
  config: Pick<ConfigDef, "dirt">,
): number {
  const indexes = roomCells(deck, compartmentKey);
  if (indexes.length === 0) return 0;
  let sum = 0;
  let max = 0;
  for (const i of indexes) {
    const value = cells[i] ?? 0;
    sum += value;
    if (value > max) max = value;
  }
  const weight = config.dirt.roomMaxWeight;
  return ((1 - weight) * (sum / indexes.length) + weight * max) / CELL_MAX;
}

/**
 * The room's tier for `dirt`: up at once to the highest threshold reached; down only once `dirt`
 * is `tierHysteresis` below the stored tier's threshold, a tier at a time.
 */
export function tierOf(dirt: number, stored: DirtTier, config: Pick<ConfigDef, "dirt">): DirtTier {
  const { untidy, dirty, filthy } = config.dirt.tiers;
  const rising: DirtTier =
    dirt >= filthy ? "filthy" : dirt >= dirty ? "dirty" : dirt >= untidy ? "untidy" : "clean";
  if (tierRank(rising) >= tierRank(stored)) return rising;
  let tier = stored;
  while (tierRank(tier) > tierRank(rising)) {
    if (dirt >= threshold(tier, config) - config.dirt.tierHysteresis) break;
    tier = BELOW[tier];
  }
  return tier;
}

/** The room dirt below which a tile is not worth a mop stroke: half the `untidy` threshold. */
export function mopWorthy(config: Pick<ConfigDef, "dirt">): number {
  return (config.dirt.tiers.untidy / 2) * CELL_MAX;
}

type FloorContent = Pick<ContentBundle, "decks" | "machines">;

const floorByDeck = new WeakMap<DeckDef, Uint8Array>();

/**
 * Cells that take dirt: authored room floor (a compartment's symbol) that no machine stands on,
 * one byte per cell (1 = floor). Cached per deck def (content is immutable). Dock floor has no
 * cell, and nobody walks or mops under a machine, so dirt there could never be cleaned.
 */
export function dirtFloor(content: FloorContent, deck: DeckDef): Uint8Array {
  const cached = floorByDeck.get(deck);
  if (cached !== undefined) return cached;
  const floor = new Uint8Array(deck.width * deck.height);
  const symbols = new Set(deck.compartments.map((c) => c.symbol));
  deck.tiles.forEach((row, y) => {
    for (let x = 0; x < row.length && x < deck.width; x++) {
      if (symbols.has(row[x] ?? " ")) floor[cellIndex(deck, { x, y })] = 1;
    }
  });
  for (const placement of deck.machines) {
    const def = content.machines[placement.machineDefId];
    for (const offset of def?.footprint ?? []) {
      const r = rotateOffset(offset, placement.rotation);
      const tile = { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
      if (inGrid(deck, tile)) floor[cellIndex(deck, tile)] = 0;
    }
  }
  floorByDeck.set(deck, floor);
  return floor;
}

/** The compartment symbol of an authored tile, if it is one. */
export function symbolAt(deck: DeckDef, tile: TileCoord): string | undefined {
  if (!inGrid(deck, tile)) return undefined;
  const symbol = deck.tiles[tile.y]?.[tile.x];
  return deck.compartments.some((c) => c.symbol === symbol) ? symbol : undefined;
}
