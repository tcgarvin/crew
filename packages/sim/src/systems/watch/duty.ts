/**
 * On and off duty (SD §11.4, D77): derived from the tick, never stored. A section has the watch
 * whose index within the day equals its place in the bill (no wrap over sections: a bill with
 * fewer sections than watches leaves those watches with nobody on). A dayworker (no section) is
 * on duty during `config.watches.dayworkerOnWatches`.
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
