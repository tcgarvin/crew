/**
 * Shift schedule (SD §11.4): on/off duty is derived from the tick, never stored.
 *
 * W4a decision: an actor whose `shiftKey` names no configured shift is always on duty (a crew
 * member without a roster entry works rather than idles). A window `[a, b)` with `a > b` wraps
 * around the cycle end.
 */
import type { Schedule } from "../../core/types/actor";
import type { DeepReadonly, Tick } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";

export function isOnDuty(schedule: DeepReadonly<Schedule>, tick: Tick, config: ConfigDef): boolean {
  const shift = config.shifts.shifts.find((s) => s.key === schedule.shiftKey);
  if (shift === undefined) return true;
  const cycle = config.shifts.cycleSeconds;
  if (cycle <= 0) return true;
  const seconds = (tick / config.time.tickRate) % cycle;
  return shift.workWindows.some(([start, end]) =>
    start <= end ? seconds >= start && seconds < end : seconds >= start || seconds < end,
  );
}
