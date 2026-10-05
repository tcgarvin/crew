/**
 * Deposits (D82): everything but footfall dirties the deck through this one function, with the
 * amount from `config.dirt.deposits` (`cooking` at the stove, `serving` and `spoiledMeal` on the
 * counter, `eating` where the eater stands, `repair` round a machine when its recipe completes,
 * `cargo` where a crate is set down).
 *
 * W2 fills this in: `amount` (of 1.0 = 255) spread over the floor cells within
 * `dirt.depositRadiusTiles` of `tile` on `deckId`, clamped to 255; dock floor has no cell.
 * Pure over state, so the equipment recipe context (no `emit`) suffices.
 *
 * Gate stub: a no-op.
 *
 * Owner: W2 of ship life slice 3.
 */
import type { TileCoord } from "../../core/types/common";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type { DeckDefId } from "../../core/types/ids";
import type { WorldState } from "../../core/types/state";

export function depositDirt(
  _state: Pick<WorldState, "dirt">,
  _content: Pick<ContentBundle, "decks">,
  _config: Pick<ConfigDef, "dirt">,
  _deckId: DeckDefId,
  _tile: TileCoord,
  _amount: number,
): void {
  // W2: the deposit (see the module comment).
}
