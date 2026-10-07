/**
 * Dockside §2.2 (D58): the star field. Stars carry no meaning, so their positions come from a
 * fixed hash and they scroll from a client-side accumulator (`StarScroll`) at the scene's
 * `starSpeed`; a reload re-scatters nothing that matters. Drawn in the deck's own ("fit") pixel
 * space, so they stream fore to aft (toward −x, D72 `orientation.ts`) and the portrait rotation
 * carries them with the deck.
 */
import { aftOf, spanAlongShip } from "./orientation";

/** One star in a square tile of the field, position in [0, 1). */
export interface Star {
  readonly x: number;
  readonly y: number;
  /** Side of the star's square in CSS pixels. */
  readonly size: number;
  /** 0..1 brightness, multiplied into the layer's alpha. */
  readonly brightness: number;
}

export interface StarLayer {
  /** Parallax: pixels this layer moves per pixel of scroll (near layers move most). */
  readonly parallax: number;
  readonly stars: readonly Star[];
}

/** The field repeats every this many CSS pixels in both directions. */
export const STAR_TILE_PX = 512;
/** Scroll speed of the nearest layer at `starSpeed` 1, in CSS pixels per real second. */
export const STAR_SPEED_PX_PER_SECOND = 700;
/** How long a near star's streak is at full speed, in CSS pixels. */
const STREAK_PX = 34;

const LAYERS = [
  { parallax: 0.18, count: 70, size: [0.8, 1.4], brightness: [0.25, 0.6] },
  { parallax: 0.5, count: 32, size: [1.1, 1.8], brightness: [0.45, 0.85] },
  { parallax: 1, count: 12, size: [1.5, 2.4], brightness: [0.7, 1] },
] as const;

/** A 32-bit integer hash (lowbias32), so the field is the same on every load. */
export function hash(n: number): number {
  let x = n | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Uniform in [0, 1) from a hash of `(layer, star, channel)`. */
function unit(layer: number, star: number, channel: number): number {
  return hash(layer * 100_003 + star * 7 + channel * 1_000_003 + 0x5eed) / 4_294_967_296;
}

export function buildStarField(): readonly StarLayer[] {
  return LAYERS.map((spec, layer) => ({
    parallax: spec.parallax,
    stars: Array.from({ length: spec.count }, (_, i) => ({
      x: unit(layer, i, 0),
      y: unit(layer, i, 1),
      size: spec.size[0] + (spec.size[1] - spec.size[0]) * unit(layer, i, 2),
      brightness:
        spec.brightness[0] + (spec.brightness[1] - spec.brightness[0]) * unit(layer, i, 3),
    })),
  }));
}

/** `value` wrapped into [0, period). */
export function wrap(value: number, period: number): number {
  return ((value % period) + period) % period;
}

/**
 * The client-side scroll accumulator. Advanced by real time × `starSpeed` (paused or
 * reduced-motion frames pass a speed of 0) and kept wrapped, so it never loses precision.
 */
export class StarScroll {
  private px = 0;

  get offsetPx(): number {
    return this.px;
  }

  advance(deltaMs: number, starSpeed: number): void {
    if (deltaMs <= 0 || starSpeed <= 0) return;
    // A long gap (a background tab) would jump the field; cap it at a tenth of a second.
    const seconds = Math.min(deltaMs, 100) / 1000;
    this.px = wrap(this.px + seconds * starSpeed * STAR_SPEED_PX_PER_SECOND, STAR_TILE_PX * 1000);
  }
}

/** The fit-space rectangle to cover, in CSS pixels. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Draws the field over `area` (fit space, CSS pixels). Streaks lengthen with `starSpeed` so
 * transit reads as speed; at rest the stars are dots.
 */
export function drawStars(
  ctx: CanvasRenderingContext2D,
  layers: readonly StarLayer[],
  area: PixelRect,
  scrollPx: number,
  starSpeed: number,
  starAlpha: number,
): void {
  if (starAlpha <= 0) return;
  ctx.fillStyle = "#e9f1ff";
  const tilesX = Math.ceil(area.width / STAR_TILE_PX) + 1;
  const tilesY = Math.ceil(area.height / STAR_TILE_PX) + 1;
  for (const layer of layers) {
    // The field moves aft as the scroll grows; wrapped into one tile so the tile loop is the same.
    const shift = wrap(aftOf(scrollPx * layer.parallax), STAR_TILE_PX);
    const streak = STREAK_PX * starSpeed * layer.parallax;
    for (const star of layer.stars) {
      ctx.globalAlpha = starAlpha * star.brightness;
      const baseX = area.x + star.x * STAR_TILE_PX + shift;
      const baseY = area.y + star.y * STAR_TILE_PX;
      for (let tx = -1; tx < tilesX; tx++) {
        // The streak trails behind the star, on its fore side: the star itself leads, moving aft.
        const trail = spanAlongShip(baseX + tx * STAR_TILE_PX, star.size, streak, 0);
        if (trail.x1 < area.x - 4 || trail.x0 > area.x + area.width + 4) continue;
        for (let ty = 0; ty < tilesY; ty++) {
          const y = baseY + ty * STAR_TILE_PX;
          if (y > area.y + area.height) break;
          ctx.fillRect(trail.x0, y, trail.x1 - trail.x0, star.size);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}
