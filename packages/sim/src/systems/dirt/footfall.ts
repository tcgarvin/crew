/**
 * Footfall and boots (§footfall-and-boots), called by spatial's `advanceActor` when a segment
 * completes (the one documented cross-system write into `state.dirt` and `actor.boots` from
 * movement, like the hazard scrape writing `scheduledFaults`). The tile is the one stepped onto.
 *
 * - On dock floor the boots gain the dock's `grime × dockGrimePerStep`
 *   (`content.docks[state.deck.dock.dockId].grime`; a fixture dock graft with no `docks` table
 *   reads 0). Dock floor has no cell.
 * - On a deck tile the tile gains `footfallPerStep + boots × bootsShed` and the boots lose the
 *   shed; then the boots pick up `bootsPickup` of what the tile now holds, and the tile loses it.
 *   The pickup is a transfer, not a copy: if the tile kept it, each pass over a lane would add a
 *   share of the lane's own dirt to the next tile and a busy corridor would grow without bound.
 *   So walking only moves dirt along (a decaying trail from the ramp); footfall and the dock's
 *   grime are what add to it.
 *
 * Owner: W2 of ship life slice 3.
 */
import { cellIndex, inGrid } from "../../core/dirt-grid";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx } from "../../core/types/pipeline";
import { isDockTile } from "../spatial/geometry";
import { CELL_MAX, addUnits } from "./grid";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function trackFootfall(
  ctx: StepCtx,
  actor: Actor,
  geometry: DeckGeometry,
  _from: TileCoord,
  to: TileCoord,
): void {
  const dirt = ctx.config.dirt;
  if (isDockTile(geometry, to.x, to.y)) {
    const dockId = ctx.state.deck.dock?.dockId;
    const grime = dockId === undefined ? 0 : (ctx.content.docks?.[dockId]?.grime ?? 0);
    actor.boots = clamp01(actor.boots + grime * dirt.dockGrimePerStep);
    return;
  }
  const deck = ctx.content.decks[geometry.deckId];
  const cells = ctx.state.dirt.cells[geometry.deckId];
  if (deck === undefined || cells === undefined || !inGrid(deck, to)) return;
  const i = cellIndex(deck, to);
  const shed = actor.boots * dirt.bootsShed;
  const trodden = addUnits(cells[i] ?? 0, (dirt.footfallPerStep + shed) * CELL_MAX);
  const picked = Math.round(trodden * dirt.bootsPickup);
  cells[i] = trodden - picked;
  actor.boots = clamp01(actor.boots - shed + picked / CELL_MAX);
}
