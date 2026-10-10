/**
 * The dirt grid's index arithmetic (§dirt-grid). One row-major cell per authored deck tile
 * (`y × width + x`), so `core/world.ts` and the migration can allocate a deck's cells without
 * importing `systems/dirt` (the `core/watch-bill.ts` precedent); the dirt system owns what the
 * cells hold.
 *
 * Owner: W2 of ship life slice 3.
 */
import type { TileCoord } from "./types/common";
import type { DeckDef } from "./types/content";
import type { LocalKey } from "./types/ids";

type GridDeck = Pick<DeckDef, "width" | "height">;

/** The cell of `tile` in `deck`'s row (no bounds check: callers read `inGrid` first). */
export function cellIndex(deck: GridDeck, tile: TileCoord): number {
  return tile.y * deck.width + tile.x;
}

/** Is `tile` inside the authored deck bounds (dock floor is not)? */
export function inGrid(deck: GridDeck, tile: TileCoord): boolean {
  return (
    Number.isInteger(tile.x) &&
    Number.isInteger(tile.y) &&
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x < deck.width &&
    tile.y < deck.height
  );
}

/** A clean deck: `width × height` zeros. */
export function emptyCells(deck: GridDeck): number[] {
  return new Array<number>(deck.width * deck.height).fill(0);
}

const roomCellsByDeck = new WeakMap<DeckDef, Map<LocalKey, readonly number[]>>();

/**
 * The cell indexes of the room `compartmentKey`'s floor tiles (its symbol in `deck.tiles`), in
 * row-major order. Cached per deck def (content is immutable); empty for an unknown key.
 */
export function roomCells(deck: DeckDef, compartmentKey: LocalKey): readonly number[] {
  let rooms = roomCellsByDeck.get(deck);
  if (rooms === undefined) {
    rooms = new Map();
    roomCellsByDeck.set(deck, rooms);
  }
  const cached = rooms.get(compartmentKey);
  if (cached !== undefined) return cached;
  const symbol = deck.compartments.find((c) => c.key === compartmentKey)?.symbol;
  const cells: number[] = [];
  if (symbol !== undefined) {
    deck.tiles.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === symbol) cells.push(y * deck.width + x);
      }
    });
  }
  rooms.set(compartmentKey, cells);
  return cells;
}
