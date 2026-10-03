/**
 * The headless pacing run (passengers-and-galaxy §7 phase-1 gate, §9). A reduced narrator
 * latency keeps the test fast; the stall model's shape (none at 1x, some at 8x) does not depend
 * on the exact latency as long as it exceeds the lead at 8x (60 s / 8 = 7.5 s).
 */
import { createKernel } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { crew } from "./index";
import {
  FAR_PORT_ID,
  HUB_PORT_ID,
  type PacingResult,
  createPacingRegistry,
  formatPacingReport,
  parsePacingArgs,
  runPacing,
} from "./pacing";

const LATENCY = 10;
const kernel = createKernel(createPacingRegistry());

/**
 * The first test to call `results()` pays for both runs (about 5 s of real work on a quiet
 * machine, more under the full parallel `pnpm test`), well past Vitest's 5 s default.
 */
const SLOW_TEST_TIMEOUT_MS = 20_000;

let cached: { slow: PacingResult; fast: PacingResult } | undefined;
function results(): { slow: PacingResult; fast: PacingResult } {
  if (cached === undefined) {
    cached = {
      slow: runPacing({ scenario: "plain", speed: 1, latencySeconds: LATENCY, seed: 1 }, kernel),
      fast: runPacing({ scenario: "plain", speed: 8, latencySeconds: LATENCY, seed: 1 }, kernel),
    };
  }
  return cached;
}

describe("crew pacing: there-and-back voyage", () => {
  it(
    "returns the ship to the hub with the voyage cleared",
    () => {
      const { slow } = results();
      expect(slow.completed).toBe(true);
      expect(slow.legs.map((leg) => [leg.fromPortId, leg.toPortId])).toEqual([
        [HUB_PORT_ID, "port.kessler_drift"],
        ["port.kessler_drift", FAR_PORT_ID],
        [FAR_PORT_ID, "port.kessler_drift"],
        ["port.kessler_drift", HUB_PORT_ID],
      ]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "raises approachingPort at every docking and jobBoard at the hub and the far port only",
    () => {
      const { slow } = results();
      expect(slow.hooksByKind.approachingPort).toBe(4);
      // Waypoint dockings do not ask the job board (§2.3).
      expect(slow.hooksByKind.jobBoard).toBe(2);
      expect(slow.totalCalls).toBeGreaterThanOrEqual(6);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "raises quietTooLong on the long legs",
    () => {
      const { slow } = results();
      const longLeg = slow.legs.find((leg) => leg.toPortId === FAR_PORT_ID);
      expect(longLeg?.hooksByKind.quietTooLong ?? 0).toBeGreaterThanOrEqual(1);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "is deterministic across speeds: same sim time and calls, only stall moves",
    () => {
      const { slow, fast } = results();
      expect(fast.simSeconds).toBe(slow.simSeconds);
      expect(fast.totalCalls).toBe(slow.totalCalls);
      expect(fast.calls.map((c) => c.kind)).toEqual(slow.calls.map((c) => c.kind));
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "hides narrator latency inside the run-ahead lead at 1x and not at 8x",
    () => {
      const { slow, fast } = results();
      expect(slow.stallSeconds).toBe(0);
      expect(fast.stallSeconds).toBeGreaterThan(0);
      // The tick-0 jobBoard is a load-time wait at every speed, not a stall.
      expect(slow.startupSeconds).toBeGreaterThanOrEqual(LATENCY);
      expect(fast.startupSeconds).toBeGreaterThanOrEqual(LATENCY);
      expect(fast.wallSeconds).toBeLessThan(slow.wallSeconds);
      // wall ≈ startup + sim / speed + stall (the loop's 50 ms grain and the first lead's fill
      // account for the slack).
      const predicted = fast.startupSeconds + fast.simSeconds / 8 + fast.stallSeconds;
      expect(Math.abs(fast.wallSeconds - predicted)).toBeLessThan(5);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "formats a markdown table with one row per speed",
    () => {
      const { slow, fast } = results();
      const report = formatPacingReport([slow, fast]);
      expect(report).toContain("| 1x |");
      expect(report).toContain("| 8x |");
      expect(report).toContain("cap of 6/hour");
      expect(report).toContain("cap of 30/hour");
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

describe("crew pacing: argument parsing", () => {
  it("defaults to all speeds, both scenarios and 25 s latency", () => {
    const parsed = parsePacingArgs([]);
    expect(parsed).toEqual({
      speeds: [1, 2, 4, 8],
      latencySeconds: 25,
      scenarios: ["plain", "freight"],
      json: false,
      seed: 1,
    });
  });

  it("reads --speeds, --latency, --scenario and --json", () => {
    const parsed = parsePacingArgs([
      "--speeds",
      "1,8",
      "--latency",
      "5",
      "--scenario",
      "plain",
      "--json",
    ]);
    expect(parsed).toEqual({
      speeds: [1, 8],
      latencySeconds: 5,
      scenarios: ["plain"],
      json: true,
      seed: 1,
    });
  });

  it("rejects a bad speed list through the crew() dispatcher", () => {
    const result = crew(["pacing", "--speeds", "fast"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--speeds");
  });
});
