/**
 * Main-thread playback (PLAN §6 W7, D14): consumes the `RenderFrame`s the worker buffers ahead of
 * the viewer and plays them back at human speed × the selected speed, interpolating actor
 * positions between consecutive frames. `FramePlayback` is pure (no DOM, no timers) so its
 * interpolation math is unit-testable; `runPlaybackLoop` is the thin `requestAnimationFrame`
 * driver used in the browser.
 */
import type { RenderActor, RenderFrame } from "@crew/sim";

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angle interpolation (radians), so a facing flip doesn't spin the long way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return a + delta * t;
}

/**
 * Interpolate between two frames at `t` in [0, 1]. Actors are matched by id; an actor present in
 * only one of the two frames (spawned/despawned) is passed through unchanged rather than
 * interpolated. Non-positional fields (machines, doors, ticker, money, travel, items, headline)
 * snap to `next` at t > 0, matching D7 (truth, not a smoothed guess).
 */
export function interpolateFrame(prev: RenderFrame, next: RenderFrame, t: number): RenderFrame {
  const clamped = Math.max(0, Math.min(1, t));
  const prevById = new Map(prev.actors.map((a) => [a.id, a] as const));
  const actors: RenderActor[] = next.actors.map((na) => {
    const pa = prevById.get(na.id);
    if (!pa) return na;
    const facing =
      pa.facing !== undefined && na.facing !== undefined
        ? lerpAngle(pa.facing, na.facing, clamped)
        : na.facing;
    return {
      ...na,
      x: lerp(pa.x, na.x, clamped),
      y: lerp(pa.y, na.y, clamped),
      ...(facing !== undefined ? { facing } : {}),
    };
  });
  return {
    ...(clamped >= 1 ? next : prev),
    tick: Math.round(lerp(prev.tick, next.tick, clamped)),
    actors,
    machines: next.machines,
    doors: next.doors,
    travel: next.travel,
    money: next.money,
    tickerEvents: next.tickerEvents,
    items: next.items,
    headline: next.headline,
  };
}

export interface PlaybackStep {
  readonly frame: RenderFrame;
  readonly viewTick: number;
}

/**
 * Buffers frames by tick and advances through them at `tickRate` (sim ticks/sec) × `speed`,
 * regardless of how far ahead the worker has buffered — the run-ahead cap (D14) is the worker's
 * job; this just plays the queue back at human speed.
 */
export class FramePlayback {
  private readonly buffer: RenderFrame[] = [];
  private elapsedMs = 0;
  private speed = 1;

  constructor(private readonly tickRate = 20) {}

  push(frame: RenderFrame): void {
    this.buffer.push(frame);
    this.buffer.sort((a, b) => a.tick - b.tick);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  get bufferedFrameCount(): number {
    return this.buffer.length;
  }

  /** Advance by `deltaMs` of real time. Returns the frame to render, or `undefined` if nothing
   * has been buffered yet. */
  advance(deltaMs: number): PlaybackStep | undefined {
    if (this.buffer.length === 0) return undefined;
    const only = this.buffer[0];
    if (this.buffer.length === 1 && only) {
      return { frame: only, viewTick: only.tick };
    }

    this.elapsedMs += Math.max(0, deltaMs) * this.speed;
    const msPerTick = 1000 / this.tickRate;

    // Drop fully-consumed leading intervals (handles a burst of buffered frames or a speed jump).
    while (this.buffer.length > 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      if (!first || !second) break;
      const intervalMs = Math.max(1, (second.tick - first.tick) * msPerTick);
      if (this.elapsedMs < intervalMs) break;
      this.elapsedMs -= intervalMs;
      this.buffer.shift();
    }

    const a = this.buffer[0];
    const b = this.buffer[1];
    if (!a || !b) {
      return a ? { frame: a, viewTick: a.tick } : undefined;
    }
    const intervalMs = Math.max(1, (b.tick - a.tick) * msPerTick);
    if (this.elapsedMs >= intervalMs) {
      this.buffer.shift();
      this.elapsedMs = 0;
      return { frame: b, viewTick: b.tick };
    }
    const t = this.elapsedMs / intervalMs;
    return { frame: interpolateFrame(a, b, t), viewTick: Math.round(lerp(a.tick, b.tick, t)) };
  }
}

export interface PlaybackLoopHandle {
  stop(): void;
}

/**
 * Drives a `FramePlayback` with `requestAnimationFrame`, calling `onStep` each frame and
 * `onViewTick` (throttled) so the caller can send `viewProgress` back to the worker.
 */
export function runPlaybackLoop(
  playback: FramePlayback,
  onStep: (step: PlaybackStep) => void,
  onViewTick: (viewTick: number) => void,
  viewTickReportIntervalMs = 250,
): PlaybackLoopHandle {
  let raf = 0;
  let last = performance.now();
  let sinceReport = 0;
  let running = true;

  function frame(now: number): void {
    if (!running) return;
    const delta = now - last;
    last = now;
    sinceReport += delta;
    const step = playback.advance(delta);
    if (step) {
      onStep(step);
      if (sinceReport >= viewTickReportIntervalMs) {
        sinceReport = 0;
        onViewTick(step.viewTick);
      }
    }
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
  return {
    stop(): void {
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}
