/**
 * Time conversion (SD §5.1, CONTRACTS rule 9). Content authors seconds; state stores integer
 * ticks. The rule is `ceil(seconds * tickRate)` so an action takes at least its duration.
 */
import type { Seconds, Tick } from "./types/common";
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
