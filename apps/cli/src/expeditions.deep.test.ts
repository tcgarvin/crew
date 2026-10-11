/**
 * `crew expeditions` (expeditions A1) on the real content: a smoke run, the bounds (lead's ruling
 * 13) that hold the fight's character while its numbers are tuned, and the flank's route.
 */
import { type Kernel, createKernel } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  type PlanSummary,
  formatExpeditionsReport,
  runExpeditions,
  runExpeditionsAsync,
  summarise,
} from "./expeditions";
import { createPacingRegistry } from "./pacing";

describe("crew expeditions: a run on the real content", () => {
  it("prints a table for the default cast", { timeout: 60_000 }, async () => {
    const options = {
      siteId: "port.boathouse" as never,
      plans: ["assault-lethal-armed"],
      casts: ["default"] as const,
      n: 1,
      seeds: [1],
    };
    const records = await runExpeditionsAsync(options);
    expect(records).toHaveLength(1);
    const report = formatExpeditionsReport(options, records);
    expect(report).toContain("## Cast: default");
    expect(report).toMatch(/\| assault-lethal-armed \| 1 \|/);
  });
});

/**
 * Lead's ruling 13: the fight's character as bounds, not values, so tuning inside them never fails
 * a test. Each plan runs in its own test (n 4 on seeds 1-2: eight fights) and the comparisons read
 * both.
 */
describe("crew expeditions: bounds on the default cast (ruling 13)", () => {
  const summaries = new Map<string, PlanSummary>();
  const runPlan = async (plan: string): Promise<PlanSummary> => {
    const records = await runExpeditionsAsync({
      siteId: "port.boathouse" as never,
      plans: [plan],
      casts: ["default"],
      n: 4,
      seeds: [1, 2],
    });
    const summary = summarise(records);
    summaries.set(plan, summary);
    return summary;
  };
  const summaryOf = (plan: string): PlanSummary => {
    const s = summaries.get(plan);
    if (s === undefined) throw new Error(`${plan} has not run`);
    return s;
  };
  const deathsPerFight = (s: PlanSummary) => s.deadPerFight.us;
  const woundsPerFight = (s: PlanSummary) =>
    Object.values(s.woundsPerFight.us).reduce((a, b) => a + b, 0);
  const meanFight = (s: PlanSummary) => {
    if (s.contactToEnd === null) throw new Error(`${s.plan}: no fight reached contact`);
    return s.contactToEnd.mean;
  };

  it("hold: few party deaths, never timed out", { timeout: 120_000 }, async () => {
    const hold = await runPlan("hold-lethal-armed");
    expect(deathsPerFight(hold)).toBeLessThanOrEqual(0.25);
    expect(hold.outcomes.timedOut + hold.outcomes.cutOff).toBe(0);
    expect(hold.outcomes.targetFled + hold.outcomes.targetTaken).toBeGreaterThanOrEqual(0.8);
  });

  it("assault: few party deaths, never timed out", { timeout: 120_000 }, async () => {
    const assault = await runPlan("assault-lethal-armed");
    expect(deathsPerFight(assault)).toBeLessThanOrEqual(0.25);
    expect(assault.outcomes.timedOut + assault.outcomes.cutOff).toBe(0);
    expect(assault.outcomes.targetTaken).toBeGreaterThanOrEqual(0.6);
  });

  it("hold costs fewer wounds and assault ends sooner", () => {
    const hold = summaryOf("hold-lethal-armed");
    const assault = summaryOf("assault-lethal-armed");
    expect(woundsPerFight(hold)).toBeLessThanOrEqual(0.75 * woundsPerFight(assault));
    expect(meanFight(assault)).toBeLessThanOrEqual(0.8 * meanFight(hold));
  });
});

describe("crew expeditions: flank on the Boathouse", () => {
  it("sends the small group round the west end, not in through the shed", () => {
    // The shed's floor inside its walls, deck frame (the Mk2 berths at dock (4,0)).
    const inShed = (x: number, y: number) => x >= 7 && x <= 26 && y >= 23 && y <= 28;
    const base = createKernel(createPacingRegistry());
    const through: string[] = [];
    let goingRound = 0;
    const flankers = new Set<string>();
    const kernel: Kernel = {
      ...base,
      advance: (world, ticks) => {
        const result = base.advance(world, ticks);
        const expedition = world.state.expedition;
        if (expedition === undefined || expedition.flankTick !== undefined) return result;
        for (const actor of Object.values(world.state.actors)) {
          const activity = actor.activity;
          if (activity.kind === "personal" && activity.label === "going round") {
            flankers.add(actor.id);
          }
          // Still on the way (firing as they go, or not): never inside.
          if (!flankers.has(actor.id) || actor.location.kind !== "onDeck") continue;
          goingRound += 1;
          const x = Math.floor(actor.location.x);
          const y = Math.floor(actor.location.y);
          if (inShed(x, y)) through.push(`${actor.name}@${x},${y}`);
        }
        return result;
      },
    };
    runExpeditions(
      {
        siteId: "port.boathouse" as never,
        plans: ["flank-lethal-armed"],
        casts: ["default"],
        n: 3,
        seeds: [1, 2],
      },
      kernel,
    );
    expect(goingRound).toBeGreaterThan(0);
    expect(through).toEqual([]);
  }, 60_000);
});
