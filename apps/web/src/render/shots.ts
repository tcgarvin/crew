/**
 * Expeditions A1 (§fight-drawing): a shot on screen, a tracer from the shooter to the target for
 * `TRACER_MS`, and on a hit a flash at the target for `HIT_FLASH_MS`. Shots reach the canvas in
 * the frames playback shows (`RenderFrame.shots`, accumulated over frames playback skipped, as
 * impacts are), so one shot can be in several frames in a row; each is keyed by its tick and ends and
 * plays once, from the moment playback first shows it, on a real-time clock held while paused.
 */
import type { RenderShot } from "@crew/sim";
import { type ViewTransform, dotRadius, toScreenPx } from "./screen";

/** Real milliseconds a tracer shows. */
export const TRACER_MS = 200;
/** Real milliseconds a hit's flash lasts; longer than the tracer, so a hit is seen at 1×. */
export const HIT_FLASH_MS = 360;
/** Ticks a shot is remembered after it was fired, so a later frame repeating it never replays it. */
const FORGET_AFTER_TICKS = 600;

export function shotKey(shot: RenderShot): string {
  return `${shot.tick}:${shot.fromX},${shot.fromY}>${shot.toX},${shot.toY}`;
}

/** A shot under way: how far through its tracer and its flash it is, each 0..1 (1 is over). */
export interface ShotTrace {
  readonly shot: RenderShot;
  readonly tracer: number;
  readonly flash: number;
}

/** The shots started so far, on a clock the canvas advances with real time. */
export class ShotTracers {
  private clockMs = 0;
  private readonly started = new Map<string, { shot: RenderShot; atMs: number }>();

  advance(deltaMs: number): void {
    if (deltaMs > 0) this.clockMs += deltaMs;
  }

  /** Start a tracer for each shot not seen before; forget ones long past `viewTick`. */
  note(shots: readonly RenderShot[], viewTick: number): void {
    for (const shot of shots) {
      const key = shotKey(shot);
      if (!this.started.has(key)) this.started.set(key, { shot, atMs: this.clockMs });
    }
    for (const [key, { shot }] of this.started) {
      if (shot.tick < viewTick - FORGET_AFTER_TICKS) this.started.delete(key);
    }
  }

  active(): ShotTrace[] {
    const traces: ShotTrace[] = [];
    for (const { shot, atMs } of this.started.values()) {
      const elapsed = this.clockMs - atMs;
      const tracer = Math.min(1, elapsed / TRACER_MS);
      const flash = shot.hit ? Math.min(1, elapsed / HIT_FLASH_MS) : 1;
      if (tracer < 1 || flash < 1) traces.push({ shot, tracer, flash });
    }
    return traces;
  }

  get tracing(): boolean {
    return this.active().length > 0;
  }
}

/** One stroke of a tracer; a tracer's strokes are drawn in order, widest (the glow) first. */
export interface TracerStroke {
  readonly rgb: string;
  readonly alpha: number;
  readonly width: number;
  /** Empty for a solid line. */
  readonly dash: readonly number[];
}

const TRACER_EDGE_RGB = "24, 16, 10";
const HIT_GLOW_RGB = "255, 150, 50";
const HIT_CORE_RGB = "255, 246, 205";
const MISS_CORE_RGB = "214, 232, 255";
const FLASH_RGB = "255, 92, 64";
const FLASH_CORE_RGB = "255, 240, 220";

/** A tracer's opacity `tracer` (0..1) through it: full for the first half, then fading out. */
function tracerFade(tracer: number): number {
  return tracer < 0.5 ? 1 : Math.max(0, (1 - tracer) * 2);
}

/**
 * §fight-drawing: a tracer's strokes, back to front, scaled to the dot so it reads on a phone.
 * Every tracer has a dark edge, so it shows on light sand as on a dark deck; a hit is a thick warm
 * line in a glow, a miss a thinner, cooler dashed line with no glow.
 */
export function tracerStrokes(hit: boolean, tracer: number, dotRadiusPx: number): TracerStroke[] {
  const fade = tracerFade(tracer);
  if (fade <= 0) return [];
  if (hit) {
    const core = Math.max(3, dotRadiusPx * 0.5);
    return [
      { rgb: HIT_GLOW_RGB, alpha: 0.35 * fade, width: core * 3.2, dash: [] },
      { rgb: TRACER_EDGE_RGB, alpha: 0.7 * fade, width: core + 2.5, dash: [] },
      { rgb: HIT_CORE_RGB, alpha: fade, width: core, dash: [] },
    ];
  }
  const core = Math.max(2, dotRadiusPx * 0.3);
  const dash = [core * 3, core * 2];
  return [
    { rgb: TRACER_EDGE_RGB, alpha: 0.6 * fade, width: core + 2, dash },
    { rgb: MISS_CORE_RGB, alpha: 0.95 * fade, width: core, dash },
  ];
}

/**
 * Draw the shots under way in screen space (upright, over the dots, so a tracer is never hidden
 * by the people it joins).
 */
export function drawShots(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  traces: readonly ShotTrace[],
  rotated: boolean,
  viewportHeight: number,
): void {
  const radius = dotRadius(t);
  for (const { shot, tracer, flash } of traces) {
    const [fx, fy] = toScreenPx(t, shot.fromX, shot.fromY, rotated, viewportHeight);
    const [tx, ty] = toScreenPx(t, shot.toX, shot.toY, rotated, viewportHeight);
    if (tracer < 1) {
      ctx.lineCap = "round";
      for (const stroke of tracerStrokes(shot.hit, tracer, radius)) {
        ctx.strokeStyle = `rgba(${stroke.rgb}, ${stroke.alpha.toFixed(3)})`;
        ctx.lineWidth = stroke.width;
        ctx.setLineDash(stroke.dash);
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineCap = "butt";
    }
    if (flash < 1) drawHitFlash(ctx, tx, ty, radius, flash);
  }
}

/** A hit's flash at the target: a bright core and an expanding red ring with a dark edge. */
function drawHitFlash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  flash: number,
): void {
  const fade = (1 - flash) * (1 - flash);
  ctx.fillStyle = `rgba(${FLASH_CORE_RGB}, ${fade.toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(x, y, radius * (1.4 - 0.6 * flash), 0, Math.PI * 2);
  ctx.fill();
  const ring = radius * (1.4 + 2 * flash);
  for (const [rgb, alpha, width] of [
    [TRACER_EDGE_RGB, 0.6 * fade, 5.5],
    [FLASH_RGB, fade, 3.5],
  ] as const) {
    ctx.strokeStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, ring, 0, Math.PI * 2);
    ctx.stroke();
  }
}
