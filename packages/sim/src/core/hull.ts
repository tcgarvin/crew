/**
 * D92, D93: the hull as rocks see it. The footprint is every authored deck tile (slice 5 call 18:
 * walls are edges in this model, so "walls included" excludes nothing); a large rock's blast is
 * its centre and eight neighbours, clipped to the footprint. The hull bar is `max` less what every
 * scar has cost and not had back, so the field (charging) and damage response (patching,
 * plating) agree on one number.
 */
import type { DeepReadonly, TileCoord } from "./types/common";
import type { DeckDef, RockSize } from "./types/content";
import type { HullScar, HullState } from "./types/state";

/** Is (x, y) an authored deck tile (any compartment character, not void)? */
export function inHullFootprint(deck: DeepReadonly<DeckDef>, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  const row = deck.tiles[y];
  if (row === undefined || x < 0 || x >= row.length) return false;
  return row.charAt(x) !== " ";
}

/** Every tile of the deck's hull footprint, row-major. */
export function hullFootprint(deck: DeepReadonly<DeckDef>): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let y = 0; y < deck.tiles.length; y += 1) {
    const row = deck.tiles[y] ?? "";
    for (let x = 0; x < row.length; x += 1) {
      if (row.charAt(x) !== " ") tiles.push({ x, y });
    }
  }
  return tiles;
}

/** The tiles a rock centred on `centre` covers: itself, or (large) its 3×3, in the footprint. */
export function blastTiles(
  deck: DeepReadonly<DeckDef>,
  centre: TileCoord,
  rock: RockSize,
): TileCoord[] {
  if (rock === "small") return inHullFootprint(deck, centre.x, centre.y) ? [centre] : [];
  const tiles: TileCoord[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = centre.x + dx;
      const y = centre.y + dy;
      if (inHullFootprint(deck, x, y)) tiles.push({ x, y });
    }
  }
  return tiles;
}

/** Hull points a scar still costs: its damage less what patching gave back. */
export function scarDamageLeft(scar: DeepReadonly<HullScar>): number {
  return scar.damage - scar.recovered;
}

/** The hull bar as its scars say it is: `max` less every scar's damage left, never below 0. */
export function integrityFromScars(hull: DeepReadonly<Pick<HullState, "max" | "scars">>): number {
  const lost = hull.scars.reduce((sum, scar) => sum + scarDamageLeft(scar), 0);
  return Math.max(0, hull.max - lost);
}

/** A whole hull for a deck: integrity at its class's `max`, no scars. */
export function wholeHull(deck: DeepReadonly<Pick<DeckDef, "hull">>): HullState {
  return { integrity: deck.hull.max, max: deck.hull.max, scars: [] };
}
