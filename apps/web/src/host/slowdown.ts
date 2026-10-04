/**
 * Auto-slowdown (D76, ship-life §9): fast-forward drops back to 1× when playback reaches an event
 * the config names (`host.slowDownOnEvents`), so 8× is a safe way to skip quiet stretches without
 * a hazard or a fault flying by. Keyed by view tick: the worker runs ahead (D14), so an event is
 * queued when it arrives and acted on only once the player sees its tick.
 *
 * Pure, no DOM or timers; `App.tsx` feeds it the worker's `events` and asks it on every playback
 * step. Cards already pause the game on their own (D14), so they are not in the list.
 */
import type { SimEvent, Tick } from "@crew/sim";

/** One queued event that should slow the game when playback reaches `event.tick`. */
export interface SlowdownMark {
  readonly event: SimEvent;
}

export class SlowdownQueue {
  private readonly types: ReadonlySet<string>;
  /** Ascending by tick; equal ticks in arrival order. */
  private marks: SlowdownMark[] = [];

  constructor(slowDownOnEvents: readonly string[]) {
    this.types = new Set(slowDownOnEvents);
  }

  /** Queue the events of `events` whose type is on the list. */
  add(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (!this.types.has(event.type)) continue;
      let index = this.marks.length;
      while (index > 0 && (this.marks[index - 1]?.event.tick ?? 0) > event.tick) index -= 1;
      this.marks.splice(index, 0, { event });
    }
  }

  /** The marks playback has reached (`tick <= viewTick`), oldest first, taken off the queue. */
  takeDue(viewTick: Tick): SlowdownMark[] {
    let count = 0;
    while (count < this.marks.length && (this.marks[count]?.event.tick ?? 0) <= viewTick) {
      count += 1;
    }
    return count === 0 ? [] : this.marks.splice(0, count);
  }

  get size(): number {
    return this.marks.length;
  }
}

/**
 * What to do when marks fall due: slow down only from fast-forward and only while playing. At 1×
 * or paused there is nothing to slow, and the marks are dropped (the line is in the log anyway).
 */
export function shouldSlowDown(
  due: readonly SlowdownMark[],
  speed: number,
  paused: boolean,
): boolean {
  return due.length > 0 && speed > 1 && !paused;
}

/** The toast: "Slowed to 1×: Debris field: Noor Haddad took us through clean". */
export function slowdownToast(line: string): string {
  return `Slowed to 1×: ${line}`;
}
