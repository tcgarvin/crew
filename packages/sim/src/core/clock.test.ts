import { describe, expect, it } from "vitest";
import {
  configTicks,
  dayTicks,
  daysToSeconds,
  perDayToPerSecond,
  secondsToTicks,
  ticksToSeconds,
  watchIndexAt,
  watchOfDay,
  watchSeconds,
  watchTicks,
} from "./clock";
import { tinyConfig } from "./fixtures/tiny-content";
import type { ConfigDef } from "./types/content";

function withTime(time: Partial<ConfigDef["time"]>): ConfigDef {
  const config = tinyConfig({ daySeconds: 1200, watchesPerDay: 3 });
  return { ...config, time: { ...config.time, ...time } };
}

describe("clock", () => {
  it("rounds durations up to whole ticks", () => {
    expect(secondsToTicks(1, 20)).toBe(20);
    expect(secondsToTicks(0.01, 20)).toBe(1);
    expect(secondsToTicks(0.051, 20)).toBe(2);
    expect(secondsToTicks(0, 20)).toBe(0);
  });

  it("does not add a tick for float noise", () => {
    expect(0.07 * 100).toBeGreaterThan(7);
    expect(secondsToTicks(0.07, 100)).toBe(7);
    expect(Object.is(secondsToTicks(0, 20), 0)).toBe(true);
  });

  it("rejects negative or non-finite input", () => {
    expect(() => secondsToTicks(-1, 20)).toThrow(RangeError);
    expect(() => secondsToTicks(Number.NaN, 20)).toThrow(RangeError);
    expect(() => secondsToTicks(1, 0)).toThrow(RangeError);
  });

  it("uses the config tick rate", () => {
    expect(configTicks(tinyConfig(), 2.5)).toBe(50);
    expect(ticksToSeconds(50, 20)).toBe(2.5);
  });

  describe("ship's day (D76)", () => {
    // A 1200 s day of three watches (the default bundle's), 20 ticks per second.
    const config = tinyConfig({ daySeconds: 1200, watchesPerDay: 3 });

    it("converts days to seconds and to ticks by the ceiling rule", () => {
      expect(daysToSeconds(config, 0.05)).toBe(60);
      expect(daysToSeconds(config, 0.0125)).toBe(15);
      expect(dayTicks(config, 0.05)).toBe(1200);
      expect(dayTicks(config, 0.075)).toBe(1800);
      expect(dayTicks(config, 0)).toBe(0);
      // Thirds of a day are not exact in binary; the snap keeps them on the tick.
      expect(dayTicks(config, 10 / 1200)).toBe(200);
      expect(dayTicks(config, 1 / 3)).toBe(8000);
    });

    it("converts a per-day rate to per second, signed rates included", () => {
      expect(perDayToPerSecond(config, 1.2)).toBeCloseTo(0.001, 15);
      expect(perDayToPerSecond(config, -12)).toBeCloseTo(-0.01, 15);
      expect(perDayToPerSecond(config, 0)).toBe(0);
    });

    it("rescales with the day while seconds knobs do not", () => {
      const short = withTime({ daySeconds: 600 });
      expect(daysToSeconds(short, 0.05)).toBe(30);
      expect(dayTicks(short, 0.05)).toBe(600);
      expect(perDayToPerSecond(short, 1.2)).toBeCloseTo(0.002, 15);
      expect(configTicks(short, 2.5)).toBe(50);
    });

    it("splits the day into watches", () => {
      expect(watchSeconds(config)).toBe(400);
      expect(watchTicks(config)).toBe(8000);
      expect(watchSeconds(withTime({ daySeconds: 600, watchesPerDay: 2 }))).toBe(300);
    });

    it("counts whole watches since tick 0 and the watch of the day", () => {
      expect(watchIndexAt(config, 0)).toBe(0);
      expect(watchIndexAt(config, 7999)).toBe(0);
      expect(watchIndexAt(config, 8000)).toBe(1);
      expect(watchIndexAt(config, 24000)).toBe(3);
      expect(watchOfDay(config, 0)).toBe(0);
      expect(watchOfDay(config, 16000)).toBe(2);
      expect(watchOfDay(config, 24000)).toBe(0);
      expect(watchOfDay(config, 24000 + 8000)).toBe(1);
    });

    it("rejects bad input rather than returning NaN", () => {
      expect(() => daysToSeconds(config, -1)).toThrow(RangeError);
      expect(() => daysToSeconds(config, Number.NaN)).toThrow(RangeError);
      // A stale config without the key reads as undefined (D76's renames): loud, not NaN.
      expect(() => dayTicks(config, undefined as unknown as number)).toThrow(RangeError);
      expect(() => perDayToPerSecond(config, Number.POSITIVE_INFINITY)).toThrow(RangeError);
      expect(() => daysToSeconds(withTime({ daySeconds: 0 }), 1)).toThrow(RangeError);
      expect(() => watchTicks(withTime({ watchesPerDay: 2.5 }))).toThrow(RangeError);
      expect(() => watchIndexAt(config, -1)).toThrow(RangeError);
      expect(() => watchIndexAt(config, 1.5)).toThrow(RangeError);
    });
  });
});
