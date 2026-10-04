import { describe, expect, it } from "vitest";
import { tinyConfig } from "../../core/fixtures/tiny-content";
import { crewConfig } from "../work/fixtures/crew-deck";
import { isOnDuty, isOnWatch, isSleepWatch, sleepWatchOf } from "./duty";

const alpha = { section: { key: "alpha", index: 0 } };
const beta = { section: { key: "beta", index: 1 } };

describe("duty (D77)", () => {
  // crewConfig: a 600 s day of two watches, so watch 0 is [0, 300) and watch 1 [300, 600).
  const config = crewConfig();
  const tickAt = (seconds: number) => seconds * config.time.tickRate;

  it("puts a section on duty for the watch of the day matching its place in the bill", () => {
    expect(isOnDuty(alpha, tickAt(10), config)).toBe(true);
    expect(isOnDuty(alpha, tickAt(310), config)).toBe(false);
    expect(isOnDuty(beta, tickAt(310), config)).toBe(true);
    expect(isOnDuty(alpha, tickAt(610), config)).toBe(true);
  });

  it("changes at the bell, not a tick early", () => {
    expect(isOnDuty(alpha, tickAt(300) - 1, config)).toBe(true);
    expect(isOnDuty(alpha, tickAt(300), config)).toBe(false);
    expect(isOnDuty(beta, tickAt(300), config)).toBe(true);
  });

  it("keeps dayworkers on `dayworkerOnWatches`, and never on watch", () => {
    const day = { ...config, watches: { ...config.watches, dayworkerOnWatches: [1] } };
    expect(isOnDuty({}, tickAt(10), day)).toBe(false);
    expect(isOnDuty({}, tickAt(310), day)).toBe(true);
    expect(isOnWatch({}, tickAt(310), day)).toBe(false);
    expect(isOnWatch(beta, tickAt(310), day)).toBe(true);
  });

  it("leaves a watch with no section to stand it uncovered (no wrap over sections)", () => {
    const three = tinyConfig({ daySeconds: 1200, watchesPerDay: 3 });
    const at = (seconds: number) => seconds * three.time.tickRate;
    expect(isOnDuty(alpha, at(10), three)).toBe(true);
    expect(isOnDuty(beta, at(410), three)).toBe(true);
    expect(isOnDuty(alpha, at(810), three)).toBe(false);
    expect(isOnDuty(beta, at(810), three)).toBe(false);
  });
});

describe("the sleep watch (D77 addendum)", () => {
  const config = crewConfig();
  const tickAt = (seconds: number) => seconds * config.time.tickRate;

  it("is the watch after one's own section's", () => {
    expect(sleepWatchOf(alpha, config)).toBe(1);
    expect(sleepWatchOf(beta, config)).toBe(0);
    expect(isSleepWatch(alpha, tickAt(310), config)).toBe(true);
    expect(isSleepWatch(alpha, tickAt(10), config)).toBe(false);
    expect(isSleepWatch(beta, tickAt(10), config)).toBe(true);
  });

  it("for a dayworker is the first watch off after the last watch on; none when on every watch", () => {
    const three = tinyConfig({ daySeconds: 1200, watchesPerDay: 3 });
    const hours = (on: number[]) => ({
      ...three,
      watches: { ...three.watches, dayworkerOnWatches: on },
    });
    expect(sleepWatchOf({}, hours([0, 1]))).toBe(2);
    expect(sleepWatchOf({}, hours([1, 2]))).toBe(0);
    expect(sleepWatchOf({}, hours([0, 2]))).toBe(1);
    expect(sleepWatchOf({}, hours([0, 1, 2]))).toBeUndefined();
    expect(sleepWatchOf({}, hours([]))).toBe(0);
  });
});
