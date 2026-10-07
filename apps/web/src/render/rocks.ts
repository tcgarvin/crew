/**
 * Slice 5 (D92, call 16): the asteroid field on screen. Two layers of rocks, placed from a fixed
 * hash like the stars (`stars.ts`): a far layer drawn after the stars and before the hull, and a
 * sparser near layer over the ship in the foreground slot. Both stream fore to aft with the stars
 * while a field is near or around the ship, fade in while it is `near`, show in full while
 * `active` and fade out while `clearing`; a stuck ship (engines out) holds them still.
 *
 * The rocks are truth only in their presence (D7): where each one is drawn means nothing, and a
 * hit is the impact flash (`impacts.ts`), not a rock reaching the hull.
 */
import type { FieldSeverity, RenderField } from "@crew/sim";
import { aftOf } from "./orientation";
import type { PixelRect } from "./stars";
import { hash, wrap } from "./stars";

/** One rock in a square tile of its layer, position in [0, 1). */
export interface Rock {
  readonly x: number;
  readonly y: number;
  /** Radius in deck tiles, so rocks keep their size against the ship at every zoom. */
  readonly radius: number;
  /** Radius multipliers of the outline's corners, going round: a lumpy, never round, rock. */
  readonly outline: readonly number[];
  /** Starting turn, radians. */
  readonly angle: number;
  /** Turns per thousand pixels scrolled; signed. */
  readonly spin: number;
  /** 0..1, how light this rock's grey is. */
  readonly shade: number;
}

export interface RockLayer {
  /** Pixels this layer moves per pixel of scroll. */
  readonly parallax: number;
  /** The layer's opacity at full fade: the near layer lets the deck show through. */
  readonly alpha: number;
  readonly rocks: readonly Rock[];
}

export interface RockField {
  readonly far: RockLayer;
  readonly near: RockLayer;
}

/** Each layer repeats every this many CSS pixels in both directions. */
export const ROCK_TILE_PX = 640;
const OUTLINE_CORNERS = 7;

const LAYER_SPECS = {
  far: { seed: 11, parallax: 0.7, count: 28, radius: [0.3, 0.9], alpha: 0.95 },
  near: { seed: 23, parallax: 1.6, count: 7, radius: [0.5, 1], alpha: 0.6 },
} as const;

/** The share of each layer's rocks a severity shows: a light field is a scatter. */
export const SEVERITY_DENSITY: Readonly<Record<FieldSeverity, number>> = {
  light: 0.4,
  heavy: 0.7,
  brutal: 1,
};

/** Uniform in [0, 1) from a hash of `(seed, rock, channel)`. */
function unit(seed: number, rock: number, channel: number): number {
  return hash(seed * 7_919 + rock * 131 + channel * 1_000_003 + 0x7a5) / 4_294_967_296;
}

function buildLayer(spec: (typeof LAYER_SPECS)[keyof typeof LAYER_SPECS]): RockLayer {
  const [low, high] = spec.radius;
  return {
    parallax: spec.parallax,
    alpha: spec.alpha,
    rocks: Array.from({ length: spec.count }, (_, i) => ({
      x: unit(spec.seed, i, 0),
      y: unit(spec.seed, i, 1),
      radius: low + (high - low) * unit(spec.seed, i, 2),
      outline: Array.from(
        { length: OUTLINE_CORNERS },
        (_, corner) => 0.72 + 0.28 * unit(spec.seed, i, 10 + corner),
      ),
      angle: unit(spec.seed, i, 3) * Math.PI * 2,
      spin: (unit(spec.seed, i, 4) - 0.5) * 4,
      shade: unit(spec.seed, i, 5),
    })),
  };
}

export function buildRockField(): RockField {
  return { far: buildLayer(LAYER_SPECS.far), near: buildLayer(LAYER_SPECS.near) };
}

/** How many of a layer's rocks a severity shows (always at least one). */
export function rocksShown(layer: RockLayer, severity: FieldSeverity): number {
  return Math.max(1, Math.ceil(layer.rocks.length * SEVERITY_DENSITY[severity]));
}

/** Real milliseconds to fade in as the field comes near (about its warning). */
export const FADE_IN_NEAR_MS = 5_000;
/** An unseen field arrives `active`: the rocks are there at once, barely faded. */
export const FADE_IN_ACTIVE_MS = 600;
export const FADE_OUT_MS = 6_000;

/**
 * The rocks' opacity, eased in real time toward what the field's phase asks for (1 near or
 * active, 0 clearing or with no field). Advanced by the canvas with the paused clock's delta, so
 * a paused game holds its fade.
 */
export class RockFade {
  private value = 0;
  /** The severity last shown, kept while the rocks fade out after the frame drops the field. */
  private shownSeverity: FieldSeverity = "light";

  get alpha(): number {
    return this.value;
  }

  get severity(): FieldSeverity {
    return this.shownSeverity;
  }

  advance(deltaMs: number, field: RenderField | undefined): void {
    if (field !== undefined) this.shownSeverity = field.severity;
    if (deltaMs <= 0) return;
    const target = fadeTarget(field);
    if (target > this.value) {
      const span = field?.phase === "active" ? FADE_IN_ACTIVE_MS : FADE_IN_NEAR_MS;
      this.value = Math.min(target, this.value + deltaMs / span);
    } else if (target < this.value) {
      this.value = Math.max(target, this.value - deltaMs / FADE_OUT_MS);
    }
  }
}

/** 1 while the field is near or around the ship, 0 while it clears or with none. */
export function fadeTarget(field: RenderField | undefined): number {
  return field !== undefined && (field.phase === "near" || field.phase === "active") ? 1 : 0;
}

/**
 * How fast the rocks stream, as a share of full transit speed: with the stars, but not at all while
 * paused or while the ship is stuck in the field (it tumbles with the rocks, not through them).
 */
export function rockScrollSpeed(
  field: RenderField | undefined,
  starSpeed: number,
  paused: boolean,
): number {
  return paused || field?.stuck === true ? 0 : starSpeed;
}

/** What `drawFrame` needs to draw both rock layers. */
export interface RockPaint {
  readonly field: RockField;
  /** The rocks' own scroll accumulator (it holds still while the ship is stuck), CSS pixels. */
  readonly scrollPx: number;
  readonly alpha: number;
  readonly severity: FieldSeverity;
}

const ROCK_DARK = [96, 86, 76] as const;
const ROCK_LIGHT = [164, 150, 132] as const;
const ROCK_RIM = "rgba(222, 208, 186, 0.7)";

function rockFill(shade: number): string {
  const channel = (i: 0 | 1 | 2) =>
    Math.round(ROCK_DARK[i] + (ROCK_LIGHT[i] - ROCK_DARK[i]) * shade);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function traceRock(
  ctx: CanvasRenderingContext2D,
  rock: Rock,
  cx: number,
  cy: number,
  radiusPx: number,
  angle: number,
): void {
  ctx.beginPath();
  rock.outline.forEach((scale, corner) => {
    const a = angle + (corner / rock.outline.length) * Math.PI * 2;
    const x = cx + Math.cos(a) * radiusPx * scale;
    const y = cy + Math.sin(a) * radiusPx * scale;
    if (corner === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

/**
 * Draw one layer over `area` (fit space, CSS pixels; `tilePx` CSS pixels per deck tile). Nothing
 * at zero opacity.
 */
export function drawRockLayer(
  ctx: CanvasRenderingContext2D,
  layer: RockLayer,
  area: PixelRect,
  tilePx: number,
  paint: RockPaint,
): void {
  const alpha = paint.alpha * layer.alpha;
  if (alpha <= 0) return;
  const scrolled = paint.scrollPx * layer.parallax;
  const shift = wrap(aftOf(scrolled), ROCK_TILE_PX);
  const tilesX = Math.ceil(area.width / ROCK_TILE_PX) + 1;
  const tilesY = Math.ceil(area.height / ROCK_TILE_PX) + 1;
  const count = rocksShown(layer, paint.severity);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = ROCK_RIM;
  ctx.lineWidth = 1;
  for (const rock of layer.rocks.slice(0, count)) {
    const radiusPx = Math.max(1.5, rock.radius * tilePx);
    const angle = rock.angle + (scrolled / 1000) * rock.spin;
    ctx.fillStyle = rockFill(rock.shade);
    const baseX = area.x + rock.x * ROCK_TILE_PX + shift;
    const baseY = area.y + rock.y * ROCK_TILE_PX;
    for (let tx = -1; tx < tilesX; tx++) {
      const x = baseX + tx * ROCK_TILE_PX;
      if (x + radiusPx < area.x || x - radiusPx > area.x + area.width) continue;
      for (let ty = 0; ty < tilesY; ty++) {
        const y = baseY + ty * ROCK_TILE_PX;
        if (y - radiusPx > area.y + area.height) break;
        traceRock(ctx, rock, x, y, radiusPx, angle);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}
