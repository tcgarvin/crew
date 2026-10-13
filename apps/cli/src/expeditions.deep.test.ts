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

/**
 * The Lazaret (§the-lazaret): a warren the party cannot hold from the bay. Holding watches the
 * dispenser go out the back, creeping in by the wards takes him, and going in never leaves a fight
 * unfinished with a crewmate down out of sight (§rescue). Bounds, not values (ruling 13).
 */
describe("crew expeditions: the Lazaret's warren", () => {
  const summaries = new Map<string, PlanSummary>();
  const runPlan = async (plan: string): Promise<PlanSummary> => {
    const records = await runExpeditionsAsync({
      siteId: "port.lazaret" as never,
      plans: [plan],
      casts: ["default"],
      n: 4,
      seeds: [1, 2],
    });
    const summary = summarise(records);
    summaries.set(plan, summary);
    return summary;
  };
  const woundsPerFight = (plan: string) =>
    Object.values(summaries.get(plan)?.woundsPerFight.us ?? {}).reduce((a, b) => a + b, 0);

  it("hold: the target mostly gets away", { timeout: 120_000 }, async () => {
    const hold = await runPlan("hold-lethal-armed");
    expect(hold.deadPerFight.us).toBeLessThanOrEqual(0.25);
    expect(hold.outcomes.targetFled).toBeGreaterThanOrEqual(0.6);
  });

  it("assault: takes the target, never timed out", { timeout: 120_000 }, async () => {
    const assault = await runPlan("assault-lethal-armed");
    expect(assault.deadPerFight.us).toBeLessThanOrEqual(0.25);
    expect(assault.outcomes.timedOut + assault.outcomes.cutOff).toBe(0);
    expect(assault.outcomes.targetTaken).toBeGreaterThanOrEqual(0.6);
  });

  it("creep: takes the target at fewer wounds than assault", { timeout: 120_000 }, async () => {
    const creep = await runPlan("creep-lethal-armed");
    expect(creep.deadPerFight.us).toBeLessThanOrEqual(0.25);
    expect(creep.outcomes.timedOut + creep.outcomes.cutOff).toBe(0);
    expect(creep.outcomes.targetTaken).toBeGreaterThanOrEqual(0.8);
    expect(woundsPerFight("creep-lethal-armed")).toBeLessThan(
      woundsPerFight("assault-lethal-armed"),
    );
  });
});

/**
 * The Boneyard (§the-boneyard): an open field the party must cross to the target. Going straight
 * across costs the most; the drainage cut is the flank's way in unseen, so the flank takes the
 * target at a fraction of the assault's wounds; holding the ramp is a long exchange that still
 * takes him. Bounds, not values (ruling 13).
 */
describe("crew expeditions: the Boneyard's open field", () => {
  const summaries = new Map<string, PlanSummary>();
  const runPlan = async (plan: string): Promise<PlanSummary> => {
    const records = await runExpeditionsAsync({
      siteId: "port.boneyard" as never,
      plans: [plan],
      casts: ["default"],
      n: 4,
      seeds: [1, 2],
    });
    const summary = summarise(records);
    summaries.set(plan, summary);
    return summary;
  };
  const woundsPerFight = (plan: string) =>
    Object.values(summaries.get(plan)?.woundsPerFight.us ?? {}).reduce((a, b) => a + b, 0);

  it("assault: costly, never timed out", { timeout: 120_000 }, async () => {
    const assault = await runPlan("assault-lethal-armed");
    expect(assault.deadPerFight.us).toBeLessThanOrEqual(0.25);
    expect(assault.outcomes.timedOut + assault.outcomes.cutOff).toBe(0);
    expect(assault.outcomes.targetTaken).toBeGreaterThanOrEqual(0.5);
    expect(woundsPerFight("assault-lethal-armed")).toBeGreaterThanOrEqual(1.5);
  });

  it(
    "flank: takes the target at under half the assault's wounds",
    { timeout: 120_000 },
    async () => {
      const flank = await runPlan("flank-lethal-armed");
      expect(flank.deadPerFight.us).toBeLessThanOrEqual(0.25);
      expect(flank.outcomes.timedOut + flank.outcomes.cutOff).toBe(0);
      expect(flank.outcomes.targetTaken).toBeGreaterThanOrEqual(0.8);
      expect(woundsPerFight("flank-lethal-armed")).toBeLessThan(
        0.5 * woundsPerFight("assault-lethal-armed"),
      );
    },
  );

  it("hold: a long exchange that still takes the target", { timeout: 120_000 }, async () => {
    const hold = await runPlan("hold-lethal-armed");
    expect(hold.deadPerFight.us).toBeLessThanOrEqual(0.25);
    expect(hold.outcomes.timedOut + hold.outcomes.cutOff).toBe(0);
    expect(hold.outcomes.targetTaken).toBeGreaterThanOrEqual(0.6);
  });
});
