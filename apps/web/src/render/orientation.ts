/**
 * Ship life §10 (§orientation-and-size): orientation is an invariant, not a parameter. The bow is
 * always east (high x in deck coordinates) and the quay always south; content validation rejects a
 * deck or dock map laid out any other way, and the sim has no notion of direction at all. The
 * renderer is the only place direction lives, and this module is the only place it is written down:
 * the hull's nose and engine bells, the stars streaming past, the port scenery and the dock sliding
 * by all take their sign from `FORE`. Distances the scene measures "aft" (`Scene.portOffset`) stay
 * positive astern; converting them to deck x goes through `aftOf`.
 *
 * The portrait turn is the one other directional choice: the deck is drawn landscape and turned a
 * quarter counter-clockwise (`draw.ts` `drawFrame`, `screen.ts` `toScreenPx`), so the bow points
 * up on a phone and the quay lies on the right.
 */

/** The sign of deck x toward the bow. */
export const FORE = 1;

/** Deck-x offset of a point `distance` tiles toward the bow (negative distance: toward the stern). */
export function foreOf(distance: number): number {
  return FORE * distance;
}

/** Deck-x offset of a point `distance` tiles toward the stern. */
export function aftOf(distance: number): number {
  return -FORE * distance;
}

/**
 * The x range of a body of `length` tiles starting at `start` (its low-x edge), grown by
 * `foreMargin` at the bow end and `aftMargin` at the stern end.
 */
export function spanAlongShip(
  start: number,
  length: number,
  foreMargin: number,
  aftMargin: number,
): { readonly x0: number; readonly x1: number } {
  const middle = start + length / 2;
  const bowEnd = middle + foreOf(length / 2 + foreMargin);
  const sternEnd = middle + aftOf(length / 2 + aftMargin);
  return { x0: Math.min(bowEnd, sternEnd), x1: Math.max(bowEnd, sternEnd) };
}

/** The bow-side and stern-side ends of the x range `[min, max]`. */
export function endsAlongShip(
  min: number,
  max: number,
): { readonly bow: number; readonly stern: number } {
  const middle = (min + max) / 2;
  const half = (max - min) / 2;
  return { bow: middle + foreOf(half), stern: middle + aftOf(half) };
}
