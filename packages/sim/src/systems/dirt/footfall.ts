/**
 * Footfall and boots (D82), called by spatial's `advanceActor` when a segment completes (the one
 * documented cross-system write into `state.dirt` and `actor.boots` from movement, like the hazard
 * scrape writing `scheduledFaults`).
 *
 * W2 fills this in: on a deck tile the tile gains `footfallPerStep + boots × bootsShed`, the boots
 * lose that shed and gain `tile × bootsPickup` (after the shed); on a dock tile the boots gain the
 * dock's `grime × dockGrimePerStep` (`content.docks[state.deck.dock.dockId].grime`; a fixture
 * dock graft with no `docks` table reads 0).
 *
 * Gate stub: a no-op.
 *
 * Owner: W2 of ship life slice 3.
 */
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx } from "../../core/types/pipeline";

export function trackFootfall(
  _ctx: StepCtx,
  _actor: Actor,
  _geometry: DeckGeometry,
  _from: TileCoord,
  _to: TileCoord,
): void {
  // W2: footfall and boots (see the module comment).
}
