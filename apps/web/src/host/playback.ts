/**
 * Main-thread playback (PLAN §6 W7, D14): consumes the `RenderFrame`s the worker buffers ahead of
 * the viewer and plays them back at human speed × the selected speed, interpolating actor
 * positions between consecutive frames. `FramePlayback` is pure (no DOM, no timers) so its
 * interpolation math is unit-testable; `runPlaybackLoop` is the thin `requestAnimationFrame`
 * driver used in the browser.
 */
import type { RenderActor, RenderFrame, RenderTravel } from "@crew/sim";

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
 * interpolated. Non-positional fields (machines, doors, ticker, money, items, headline, and the
 * dock alongside, D61) snap to `next` at t > 0, matching D7 (truth, not a smoothed guess). Travel
 * progress is positional for the scenery (D58), so it is interpolated within one stage of one leg
 * and snaps otherwise.
 */
export function interpolateFrame(prev: RenderFrame, next: RenderFrame, t: number): RenderFrame {
  const clamped = Math.max(0, Math.min(1, t));
  // D61: the dock comes and goes with a stage change, so it snaps to `next` like the doors; an
  // optional field cannot ride the base spread, which would keep `prev`'s dock for a frame.
  const { dock: _prevDock, ...base } = clamped >= 1 ? next : prev;
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
    ...base,
    ...(next.dock === undefined ? {} : { dock: next.dock }),
    tick: Math.round(lerp(prev.tick, next.tick, clamped)),
    actors,
    machines: next.machines,
    doors: next.doors,
    travel: interpolateTravel(prev.travel, next.travel, clamped),
    money: next.money,
    tickerEvents: next.tickerEvents,
    items: next.items,
    headline: next.headline,
  };
}

/**
 * D58: the berth slides with stage progress, and frames come every 100 sim-ms, so a snapped
 * progress would step the scenery visibly. Interpolate only between two frames of the same stage
 * and leg; across a stage change the next frame's value is the truth.
 */
export function interpolateTravel(prev: RenderTravel, next: RenderTravel, t: number): RenderTravel {
  const sameStretch =
    prev.state === next.state &&
    prev.fromPortId === next.fromPortId &&
    prev.toPortId === next.toPortId;
  if (!sameStretch) return next;
  return { ...next, progress: lerp(prev.progress, next.progress, t) };
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
    // Frames arrive in tick order from the worker, so the common case is a plain append; with
    // hundreds of frames buffered (D30 bursts) a sort per push would be O(n log n) per frame.
    const last = this.buffer[this.buffer.length - 1];
    if (last === undefined || last.tick <= frame.tick) {
      this.buffer.push(frame);
      return;
    }
    let index = this.buffer.length - 1;
    while (index > 0) {
      const candidate = this.buffer[index - 1];
      if (candidate === undefined || candidate.tick <= frame.tick) break;
      index -= 1;
    }
    this.buffer.splice(index, 0, frame);
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
