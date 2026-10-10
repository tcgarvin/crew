/**
 * Slice 5 (§rock-impacts, call 16): a rock strike on screen, a short flash over every tile the
 * blast covered and a ring at its centre. Impacts reach the canvas in the frames playback shows
 * (`RenderFrame.impacts`, accumulated over frames playback skipped), so the same impact can be in
 * several frames in a row; each is keyed by its tick and centre and flashes once, from the moment
 * playback first shows it.
 */
import type { RenderImpact } from "@crew/sim";

/** Real milliseconds a flash lasts. */
export const FLASH_MS = 700;
/** Ticks an impact is remembered after it landed, so a later frame repeating it never replays it. */
const FORGET_AFTER_TICKS = 600;

export function impactKey(impact: Pick<RenderImpact, "tick" | "x" | "y">): string {
  return `${impact.tick}:${impact.x},${impact.y}`;
}

/** One flash under way: its impact and how far through it is, 0..1. */
export interface Flash {
  readonly impact: RenderImpact;
  readonly t: number;
}

/**
 * The flashes started so far, on a clock the canvas advances with real time (not while paused,
 * so a paused game holds the flash where it was).
 */
export class ImpactFlashes {
  private clockMs = 0;
  private readonly started = new Map<string, { impact: RenderImpact; atMs: number }>();

  advance(deltaMs: number): void {
    if (deltaMs > 0) this.clockMs += deltaMs;
  }

  /** Start a flash for each impact not seen before; forget ones long past `viewTick`. */
  note(impacts: readonly RenderImpact[], viewTick: number): void {
    for (const impact of impacts) {
      const key = impactKey(impact);
      if (!this.started.has(key)) this.started.set(key, { impact, atMs: this.clockMs });
    }
    for (const [key, { impact }] of this.started) {
      if (impact.tick < viewTick - FORGET_AFTER_TICKS) this.started.delete(key);
    }
  }

  active(): Flash[] {
    const flashes: Flash[] = [];
    for (const { impact, atMs } of this.started.values()) {
      const t = (this.clockMs - atMs) / FLASH_MS;
      if (t < 1) flashes.push({ impact, t });
    }
    return flashes;
  }

  get flashing(): boolean {
    return this.active().length > 0;
  }
}

const FLASH_RGB = "255, 196, 120";
const CORE_RGB = "255, 246, 224";

/**
 * Draw the flashes. The context must be in deck tile units (`inTileSpace`); `px` is one CSS pixel
 * in tiles.
 */
export function drawImpactFlashes(
  ctx: CanvasRenderingContext2D,
  flashes: readonly Flash[],
  px: number,
): void {
  for (const { impact, t } of flashes) {
    const fade = (1 - t) * (1 - t);
    ctx.fillStyle = `rgba(${FLASH_RGB}, ${(0.75 * fade).toFixed(3)})`;
    for (const tile of impact.tiles) ctx.fillRect(tile.x, tile.y, 1, 1);
    const cx = impact.x + 0.5;
    const cy = impact.y + 0.5;
    const reach = impact.rock === "large" ? 1.6 : 0.8;
    ctx.fillStyle = `rgba(${CORE_RGB}, ${fade.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 0.35 * (1 - t) + 0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${FLASH_RGB}, ${fade.toFixed(3)})`;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(cx, cy, 0.2 + reach * t, 0, Math.PI * 2);
    ctx.stroke();
  }
}
