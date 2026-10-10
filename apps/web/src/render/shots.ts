/**
 * Expeditions A1 (§8.6): a shot on screen, a tracer from the shooter to the target for
 * `TRACER_MS`, and on a hit a flash at the target for `HIT_FLASH_MS`. Shots reach the canvas in
 * the frames playback shows (`RenderFrame.shots`, accumulated over frames playback skipped, as
 * impacts are), so one shot can be in several frames in a row; each is keyed by its tick and ends and
 * plays once, from the moment playback first shows it, on a real-time clock held while paused.
 */
import type { RenderShot } from "@crew/sim";
import { type ViewTransform, dotRadius, toScreenPx } from "./screen";

/** Real milliseconds a tracer shows. */
export const TRACER_MS = 120;
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

const TRACER_RGB = "255, 236, 170";
const FLASH_RGB = "255, 92, 64";
const FLASH_CORE_RGB = "255, 240, 220";

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
      const fade = 1 - tracer;
      ctx.strokeStyle = `rgba(${TRACER_RGB}, ${(0.95 * fade).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
    if (flash < 1) {
      const fade = (1 - flash) * (1 - flash);
      ctx.fillStyle = `rgba(${FLASH_CORE_RGB}, ${fade.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(tx, ty, radius * (1.1 - 0.5 * flash), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${FLASH_RGB}, ${fade.toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(tx, ty, radius * (1.2 + 1.6 * flash), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
