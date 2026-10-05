/**
 * On and off duty (SD §11.4, D77): derived from the tick, never stored. A section has the watch
 * whose index within the day equals its place in the bill (no wrap over sections: a bill with
 * fewer sections than watches leaves those watches with nobody on). A dayworker (no section) is
 * on duty during `config.watches.dayworkerOnWatches`.
 *
 * The sleep watch (D77 addendum): the watch after one's own is when routine tiredness is slept
 * off, so each section turns in at the same bell every day ("Priya sleeps after her watch") and
 * the sleep window cannot drift with the fatigue rate. A dayworker's is the first watch off duty
 * after their last watch on; someone on duty every watch of the day has none.
 *
 * Owner: W1 of ship life slice 2.
 */
import { watchOfDay } from "../../core/clock";
import type { Schedule } from "../../core/types/actor";
import type { DeepReadonly, Tick } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";

export function isOnDuty(schedule: DeepReadonly<Schedule>, tick: Tick, config: ConfigDef): boolean {
  const watch = watchOfDay(config, tick);
  const section = schedule.section;
  if (section === undefined) return config.watches.dayworkerOnWatches.includes(watch);
  return section.index === watch;
}

/** Their section has the watch now; always false for a dayworker. */
export function isOnWatch(
  schedule: DeepReadonly<Schedule>,
  tick: Tick,
  config: ConfigDef,
): boolean {
  const section = schedule.section;
  return section !== undefined && section.index === watchOfDay(config, tick);
}

/**
 * The watch of the day in which routine tiredness is slept off: the one after their own section's
 * (a dayworker's: the first off-duty watch after their last on-duty one). Undefined for a
 * dayworker on duty every watch, who has no window and sleeps only when pressed.
 */
export function sleepWatchOf(
  schedule: DeepReadonly<Schedule>,
  config: ConfigDef,
): number | undefined {
  const watches = config.time.watchesPerDay;
  const section = schedule.section;
  if (section !== undefined) return (section.index + 1) % watches;
  const on = config.watches.dayworkerOnWatches.filter((watch) => watch < watches);
  if (on.length === 0) return 0;
  const last = Math.max(...on);
  for (let step = 1; step <= watches; step++) {
    const watch = (last + step) % watches;
    if (!on.includes(watch)) return watch;
  }
  return undefined;
}

/** Is `tick` in their sleep watch (`sleepWatchOf`)? */
export function isSleepWatch(
  schedule: DeepReadonly<Schedule>,
  tick: Tick,
  config: ConfigDef,
): boolean {
  return sleepWatchOf(schedule, config) === watchOfDay(config, tick);
}
