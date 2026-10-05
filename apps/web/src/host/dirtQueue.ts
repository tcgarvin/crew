/**
 * The dirt channel's playback side (D82, ship-life slice 3 call 14). The worker posts a
 * `DirtFrame` on load and every `host.dirtFrameEverySeconds` of sim time, but it runs ahead of
 * the viewer (D14), so a frame is queued by its tick when it arrives and shown only once playback
 * reaches that tick: a tint that darkened before the footsteps that made it would read as a bug.
 *
 * Pure, no DOM or timers; `App.tsx` feeds it the worker's `dirt` messages and asks it on every
 * playback step, as it does the slowdown queue.
 */
import type { DirtFrame, Tick } from "@crew/sim";

export class DirtQueue {
  /** Ascending by tick; a frame at a tick already queued replaces it (the later post is newer). */
  private frames: DirtFrame[] = [];

  /** Queue a frame from the worker. */
  add(frame: DirtFrame): void {
    let index = this.frames.length;
    while (index > 0 && (this.frames[index - 1]?.tick ?? 0) > frame.tick) index -= 1;
    const before = this.frames[index - 1];
    if (before !== undefined && before.tick === frame.tick) {
      this.frames[index - 1] = frame;
      return;
    }
    this.frames.splice(index, 0, frame);
  }

  /**
   * The newest queued frame playback has reached (`tick <= viewTick`), taken off the queue with
   * every older one, or `undefined` when none has fallen due since the last call (the picture
   * keeps the frame it has). Frames ahead of `viewTick` stay queued.
   */
  takeDue(viewTick: Tick): DirtFrame | undefined {
    let count = 0;
    while (count < this.frames.length && (this.frames[count]?.tick ?? 0) <= viewTick) count += 1;
    if (count === 0) return undefined;
    const due = this.frames.splice(0, count);
    return due[due.length - 1];
  }

  get size(): number {
    return this.frames.length;
  }
}
