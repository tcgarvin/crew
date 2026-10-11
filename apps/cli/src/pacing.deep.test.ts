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
  runPacingAsync,
} from "./pacing";

const LATENCY = 10;
const kernel = createKernel(createPacingRegistry());

/**
 * The first test to need each run pays for it (about 10 s of real work on a quiet machine since
 * Kessler–Ossory is a 400 s spur (§the-ships-day), several times that under the full parallel `pnpm
 * test`), well past Vitest's 5 s default. The runs yield between chunks (`runPacingAsync`,
 * `yielding.ts`; slice-5 integration): a synchronous run held the worker past the minute its RPC
 * allows ("Timeout calling onTaskUpdate") under load.
 */
const SLOW_TEST_TIMEOUT_MS = 120_000;

const cached: { slow?: Promise<PacingResult>; fast?: Promise<PacingResult> } = {};
function slowRun(): Promise<PacingResult> {
  cached.slow ??= runPacingAsync(
    { scenario: "plain", speed: 1, latencySeconds: LATENCY, seed: 1 },
    kernel,
  );
  return cached.slow;
}
function fastRun(): Promise<PacingResult> {
  cached.fast ??= runPacingAsync(
    { scenario: "plain", speed: 8, latencySeconds: LATENCY, seed: 1 },
    kernel,
  );
  return cached.fast;
}
async function results(): Promise<{ slow: PacingResult; fast: PacingResult }> {
  return { slow: await slowRun(), fast: await fastRun() };
}

describe("crew pacing: there-and-back voyage", () => {
  it(
    "returns the ship to the hub with the voyage cleared",
    async () => {
      const slow = await slowRun();
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
    "raises stageDock at every docking and captainAshore at the hub and the far port only",
    async () => {
      const slow = await slowRun();
      // §staging-hook-and-the-hold: the staging call is guaranteed, waypoints included.
      expect(slow.hooksByKind.stageDock).toBe(4);
      // Waypoint dockings do not send the captain ashore for work (§2.3).
      expect(slow.hooksByKind.captainAshore).toBe(2);
      expect(slow.totalCalls).toBeGreaterThanOrEqual(6);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "raises quietTooLong only on the watch-long spur legs, at most once per quiet window (a watch, §the-ships-day)",
    async () => {
      const slow = await slowRun();
      // A spur leg is one watch of transit and the quiet window is one watch, with `stageDock`
      // raised 10 s before the approach: a leg flown at nominal speed with no fault to repair
      // ends a breath short of a quiet call, so whether one lands depends on the leg running
      // long. What holds is the bound, and that a short leg is never "quiet".
      for (const leg of slow.legs) {
        const spur = leg.toPortId === FAR_PORT_ID || leg.fromPortId === FAR_PORT_ID;
        const watches = Math.ceil(leg.simSeconds / slow.quietTooLongSeconds);
        expect(leg.hooksByKind.quietTooLong ?? 0).toBeLessThanOrEqual(spur ? watches : 0);
      }
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "is deterministic across speeds: same sim time and calls, only stall moves",
    async () => {
      const { slow, fast } = await results();
      expect(fast.simSeconds).toBe(slow.simSeconds);
      expect(fast.totalCalls).toBe(slow.totalCalls);
      expect(fast.calls.map((c) => c.kind)).toEqual(slow.calls.map((c) => c.kind));
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  it(
    "hides narrator latency inside the run-ahead lead at 1x and not at 8x",
    async () => {
      const { slow, fast } = await results();
      // §captain-ashore-ask: the first ask comes when the captain steps onto the dock, some seconds
      // into the game, not at tick 0: no load-time wait, and at 1x only that first call (raised
      // before a full lead has built) shows through as stall.
      expect(slow.startupSeconds).toBe(0);
      expect(fast.startupSeconds).toBe(0);
      const [first, ...rest] = slow.calls;
      expect(first?.kind).toBe("captainAshore");
      expect(first?.stallSeconds ?? 0).toBeLessThan(LATENCY);
      expect(rest.every((c) => c.stallSeconds === 0)).toBe(true);
      expect(fast.stallSeconds).toBeGreaterThan(slow.stallSeconds);
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
    async () => {
      const { slow, fast } = await results();
      const report = formatPacingReport([slow, fast]);
      expect(report).toContain("| 1x |");
      expect(report).toContain("| 8x |");
      expect(report).toContain("calls per round trip.");
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
