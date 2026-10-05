/**
 * Room dirt and tiers (D82). `roomDirt = (1 − roomMaxWeight) × mean + roomMaxWeight × max` over
 * the room's floor cells (`core/dirt-grid.ts` `roomCells`), as a share of 1.0; `tierOf` applies
 * `dirt.tiers.{untidy, dirty, filthy}` rising and `tierHysteresis` falling against the room's
 * stored tier.
 *
 * Gate stubs: 0 and `clean`.
 *
 * Owner: W2 of ship life slice 3.
 */
import type { ConfigDef, DeckDef, DirtTier } from "../../core/types/content";
import type { LocalKey } from "../../core/types/ids";

export function roomDirt(
  _cells: readonly number[],
  _deck: DeckDef,
  _compartmentKey: LocalKey,
  _config: Pick<ConfigDef, "dirt">,
): number {
  return 0;
}

export function tierOf(
  _dirt: number,
  _stored: DirtTier,
  _config: Pick<ConfigDef, "dirt">,
): DirtTier {
  return "clean";
}
