import { describe, expect, it } from "vitest";
import { type BeatsResult, formatBeatsReport, runBeatsAsync } from "./beats";
import { crew } from "./index";

describe("crew beats: one ship's day of the pacing voyage (real content, every system)", () => {
  // One run for every pin below (a ship's day of the real game takes a while), yielding between
  // chunks so the worker's RPC is answered (`yielding.ts`).
  let day: Promise<BeatsResult> | undefined;
  const oneDay = (): Promise<BeatsResult> => {
    day ??= runBeatsAsync({ scenario: "freight", days: 1, seed: 1, fields: "none" });
    return day;
  };

  it("completes and rings three bells, one per watch", async () => {
    const result = await oneDay();
    expect(result.watches).toBe(3);
    expect(result.simSeconds).toBe(result.days * 3 * result.watchSeconds);
    expect(result.beats.bells).toMatchObject({ total: 3, perWatchMin: 1, perWatchMax: 1 });
    expect(result.people).toHaveLength(9);
    for (const person of result.people) {
      const sum = Object.values(person.shares).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1);
    }
    const report = formatBeatsReport([result]);
    expect(report).toContain("# Beats: 1 day, 3 watches of 400 s (seed 1,");
    expect(report).toContain("Fields: none scheduled (--fields none).");
    expect(report).toContain("| bells | 3 | 1.00 | 1 | 1 |");
    // §mess-call: the cook serves a meal before each bell, so a day is three meals, none missed.
    expect(result.beats.mealsServed).toMatchObject({ total: 3, perWatchMin: 1, perWatchMax: 1 });
    expect(result.beats.mealsMissed.total).toBe(0);
    expect(report).toContain("| mealsServed | 3 | 1.00 | 1 | 1 |");
    for (const row of ["eatenHot", "eatenRation", "roomsCleaned"]) {
      expect(report).toContain(`| ${row} | `);
    }
    expect(report).toContain("| filthy rooms at watch end | ");
    expect(report).toMatch(/Mess: \d+ meals? served/);
    expect(report).toMatch(/Provisions at the end: \d+ crates, [\d.]+ days\./);
    expect(report).toContain("| cooking | mopping |");
    expect(Number.isFinite(result.provisionsDaysAtEnd)).toBe(true);
  }, 90_000);

  it("reports at least one handover at the helm in a one-day run (§handover)", async () => {
    expect((await oneDay()).beats.handovers.total).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("prints the off-watch columns and lines (§activities-and-interests, §the-beats-instrument)", async () => {
    const result = await oneDay();
    const report = formatBeatsReport([result]);
    for (const row of [
      "sessionsStarted",
      "contests",
      "arguments",
      "soloActivities",
      "tickerLines",
      "offWatchLines",
    ]) {
      expect(report).toContain(`| ${row} | `);
    }
    expect(report).toContain("| recreating | helm |");
    expect(report).toContain("| Days recreated | Longest bored s |");
    expect(report).toContain("| Activity | Opened | Started | Collapsed | Abandoned | Solo |");
    expect(report).toMatch(/Sessions collapsed: .+ opened\./);
    expect(report).toMatch(/Warmest at the end: .+\. Coldest: .+\./);
    expect(report).toMatch(/Rivalries at the end: .+\./);
    // The ticker is read off the render frame: a day of bells, meals and helm changes says something.
    expect(result.beats.tickerLines.total).toBeGreaterThan(0);
  }, 90_000);

  it("reports at least one session started in a one-day run (slice 4 W1)", async () => {
    const result = await oneDay();
    expect(result.beats.sessionsStarted.total).toBeGreaterThanOrEqual(1);
    // Every started session ends in the off-watch family's lines (call 18).
    expect(result.beats.offWatchLines.total).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("reports each wearing machine's condition by day, its lowest and its services (§maintenance-due)", async () => {
    const result = await oneDay();
    const names = result.machineWear.map((m) => m.name);
    expect(names).toContain("Coolant Pump");
    expect(names).toContain("Life Support Unit");
    expect(names).not.toContain("Bunk");
    for (const machine of result.machineWear) {
      expect(machine.byDay).toHaveLength(1);
      expect(machine.lowest).toBeLessThanOrEqual(machine.byDay[0] ?? 1);
    }
    expect(formatBeatsReport([result])).toContain("| Machine | Day 1 | Lowest | Services |");
  }, 90_000);
});
