/**
 * Deposits (§dirt-deposits): everything but footfall dirties the deck through this one function,
 * with the amount from `config.dirt.deposits` (`cooking` at the stove, `serving` and `spoiledMeal`
 * on the counter, `eating` where the eater stands, `repair` round a machine when its recipe
 * completes, `cargo` where a crate is set down).
 *
 * `amount` (of 1.0 = 255) is shared evenly over the floor cells (`dirtFloor`: no dock floor, no
 * machine footprint) within `dirt.depositRadiusTiles` (a square) of `tile` that lie in the same
 * room as `tile`, each cell rounded and clamped to 255: a repair's mess stays in the machine's
 * room rather than leaking through the wall. Pure over state, so the equipment recipe context
 * (no `emit`) suffices.
 *
 * Owner: W2 of ship life slice 3.
 */
import { cellIndex } from "../../core/dirt-grid";
import type { TileCoord } from "../../core/types/common";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type { DeckDefId } from "../../core/types/ids";
import type { WorldState } from "../../core/types/state";
import { CELL_MAX, addUnits, dirtFloor, symbolAt } from "./grid";

export function depositDirt(
  state: Pick<WorldState, "dirt">,
  content: Pick<ContentBundle, "decks" | "machines">,
  config: Pick<ConfigDef, "dirt">,
  deckId: DeckDefId,
  tile: TileCoord,
  amount: number,
): void {
  const deck = content.decks[deckId];
  const cells = state.dirt.cells[deckId];
  if (deck === undefined || cells === undefined || amount <= 0) return;
  const room = symbolAt(deck, tile);
  if (room === undefined) return;
  const floor = dirtFloor(content, deck);
  const radius = Math.max(0, Math.floor(config.dirt.depositRadiusTiles));
  const targets: number[] = [];
  for (let y = tile.y - radius; y <= tile.y + radius; y++) {
    for (let x = tile.x - radius; x <= tile.x + radius; x++) {
      if (symbolAt(deck, { x, y }) !== room) continue;
      const i = cellIndex(deck, { x, y });
      if (floor[i] === 1) targets.push(i);
    }
  }
  if (targets.length === 0) return;
  const units = (amount * CELL_MAX) / targets.length;
  for (const i of targets) cells[i] = addUnits(cells[i] ?? 0, units);
}
