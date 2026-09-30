import { describe, expect, it } from "vitest";
import { configTicks, secondsToTicks, ticksToSeconds } from "./clock";
import { tinyConfig } from "./fixtures/tiny-content";

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
});
