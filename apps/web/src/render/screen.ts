/**
 * The fit transform and its forward mapping to screen pixels, shared by every layer drawn upright
 * in screen space (`draw.ts` for the crew and deck items, `locals.ts` for the dock's own people
 * and props).
 */

export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function toPx(t: ViewTransform, x: number, y: number): readonly [number, number] {
  return [t.offsetX + x * t.scale, t.offsetY + y * t.scale];
}

/**
 * Map a point in the transform's local ("fit") space to real screen pixels, applying the same
 * quarter turn counter-clockwise `drawFrame` applies to the canvas (§orientation-and-size: the bow,
 * +x, points up on a phone; `orientation.ts`) — used to place text after `ctx.restore()` so labels
 * stay upright (task item 5).
 */
export function toScreenPx(
  t: ViewTransform,
  x: number,
  y: number,
  rotated: boolean,
  viewportHeight: number,
): readonly [number, number] {
  const [lx, ly] = toPx(t, x, y);
  if (!rotated) return [lx, ly];
  // Matches the canvas transform in `drawFrame`: translate(0, viewportHeight); rotate(-90deg).
  return [ly, viewportHeight - lx];
}

/** >= 8px diameter at 390px width, per the brief. */
const MIN_DOT_RADIUS = 4;

/** A person's dot radius, CSS pixels: crew, passengers and locals are all the same size. */
export function dotRadius(t: ViewTransform): number {
  return Math.max(MIN_DOT_RADIUS, t.scale * 0.22);
}

/** The side of a carried crate, or the unit a hand truck is drawn in, CSS pixels. */
export function carriedSize(t: ViewTransform): number {
  return Math.max(8, t.scale * 0.36);
}

export const TEXT_COLOR = "#e7edf3";
