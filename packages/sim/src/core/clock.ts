/**
 * Time conversion (SD §5.1, CONTRACTS rule 9). Content authors seconds; state stores integer
 * ticks. The rule is `ceil(seconds * tickRate)` so an action takes at least its duration.
 */
import type { Days, Seconds, Tick } from "./types/common";
import type { ConfigDef } from "./types/content";

/**
 * W2 decision: products within 1e-9 of an integer are snapped before the ceiling, so float noise
 * (0.15 * 20 = 3.0000000000000004) does not add a tick.
 */
const CEIL_EPSILON = 1e-9;

export function secondsToTicks(seconds: Seconds, tickRate: number): Tick {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`secondsToTicks: seconds must be finite and >= 0, got ${seconds}`);
  }
  if (!Number.isFinite(tickRate) || tickRate <= 0) {
    throw new RangeError(`secondsToTicks: tickRate must be finite and > 0, got ${tickRate}`);
  }
  // max() also turns the -0 from ceil(-epsilon) into 0.
  return Math.max(0, Math.ceil(seconds * tickRate - CEIL_EPSILON));
}

export function ticksToSeconds(ticks: Tick, tickRate: number): Seconds {
  return ticks / tickRate;
}

/** `secondsToTicks` at the config's tick rate. */
export function configTicks(config: ConfigDef, seconds: Seconds): Tick {
  return secondsToTicks(seconds, config.time.tickRate);
}

// ---------------------------------------------------------------------------------------------
// Ship's day (§the-ships-day)
// ---------------------------------------------------------------------------------------------
//
// Day-relative knobs (`Days`, and rates per day) stay as authored in the config, which every save
// embeds, and are converted here where read. Physical motion, work at a machine and host real
// time stay in seconds and never pass through these.

function daySeconds(config: ConfigDef): Seconds {
  const seconds = config.time.daySeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError(`config.time.daySeconds must be finite and > 0, got ${seconds}`);
  }
  return seconds;
}

function watchesPerDay(config: ConfigDef): number {
  const watches = config.time.watchesPerDay;
  if (!Number.isInteger(watches) || watches <= 0) {
    throw new RangeError(`config.time.watchesPerDay must be a positive integer, got ${watches}`);
  }
  return watches;
}

/** A `Days` duration in sim-seconds. */
export function daysToSeconds(config: ConfigDef, days: Days): Seconds {
  if (!Number.isFinite(days) || days < 0) {
    throw new RangeError(`daysToSeconds: days must be finite and >= 0, got ${days}`);
  }
  return days * daySeconds(config);
}

/** A `Days` duration in ticks, by the same ceiling rule as `configTicks`. */
export function dayTicks(config: ConfigDef, days: Days): Tick {
  return configTicks(config, daysToSeconds(config, days));
}

/** A rate per ship's day as a rate per sim-second. Signed rates are allowed. */
export function perDayToPerSecond(config: ConfigDef, ratePerDay: number): number {
  if (!Number.isFinite(ratePerDay)) {
    throw new RangeError(`perDayToPerSecond: rate must be finite, got ${ratePerDay}`);
  }
  return ratePerDay / daySeconds(config);
}

/** Sim-seconds in one watch. */
export function watchSeconds(config: ConfigDef): Seconds {
  return daySeconds(config) / watchesPerDay(config);
}

/** Ticks in one watch (at least one). */
export function watchTicks(config: ConfigDef): Tick {
  return Math.max(1, configTicks(config, watchSeconds(config)));
}

/** Whole watches elapsed since tick 0: 0 during the first watch, counting up forever. */
export function watchIndexAt(config: ConfigDef, tick: Tick): number {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new RangeError(`watchIndexAt: tick must be an integer >= 0, got ${tick}`);
  }
  return Math.floor(tick / watchTicks(config));
}

/** Which watch of the day `tick` falls in, `0 .. watchesPerDay - 1`. */
export function watchOfDay(config: ConfigDef, tick: Tick): number {
  return watchIndexAt(config, tick) % watchesPerDay(config);
}
