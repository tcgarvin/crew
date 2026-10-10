/**
 * `crew expeditions` (expeditions A1): argument parsing, the cast variants, the plan choice, the
 * summary, a smoke run on the real content, and the CI bounds (lead's ruling 13) that hold the
 * fight's character while its numbers are tuned.
 */
import type { PlanOption, SiteCastEntryDef } from "@crew/sim";
import { DEFAULT_PLANS } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  type FightRecord,
  type PlanSummary,
  castFor,
  formatExpeditionsReport,
  instrumentPlans,
  parseExpeditionsArgs,
  parseSeeds,
  runExpeditionsAsync,
  runExpeditionsCli,
  summarise,
} from "./expeditions";
import { loadPacingContent } from "./pacing";

function boathouseCast(): readonly SiteCastEntryDef[] {
  const dock = loadPacingContent().bundle.docks?.["dock.boathouse" as never];
  if (dock?.defaultCast === undefined) throw new Error("the Boathouse has no default cast");
  return dock.defaultCast;
}

describe("crew expeditions: arguments", () => {
  it("defaults to the Boathouse, every plan and cast, 20 fights on seeds 1-5", () => {
    expect(parseExpeditionsArgs([])).toEqual({
      siteId: "port.boathouse",
      plans: "all",
      casts: ["default", "shaky", "hard"],
      n: 20,
      seeds: [1, 2, 3, 4, 5],
      json: false,
    });
  });

  it("reads plans, casts, n, seeds and --json", () => {
    expect(
      parseExpeditionsArgs([
        "--plans",
        "hold-lethal-armed,assault-lethal-armed",
        "--casts",
        "shaky,hard",
        "--n",
        "4",
        "--seeds",
        "1,3",
        "--json",
      ]),
    ).toMatchObject({
      plans: ["hold-lethal-armed", "assault-lethal-armed"],
      casts: ["shaky", "hard"],
      n: 4,
      seeds: [1, 3],
      json: true,
    });
  });

  it("says what is wrong with a bad option", () => {
    expect(parseExpeditionsArgs(["--casts", "brave"])).toEqual({
      error: '--casts: expected default, shaky, hard or all, got "brave"',
    });
    expect(parseExpeditionsArgs(["--n", "0"])).toHaveProperty("error");
    expect(parseExpeditionsArgs(["--n"])).toEqual({ error: "--n: missing a value" });
    expect(parseExpeditionsArgs(["--fast", "1"])).toEqual({ error: 'unknown option "--fast"' });
    expect(runExpeditionsCli(["--seeds", "5-1"]).exitCode).toBe(1);
  });

  it("reads seeds as one, a range or a list", () => {
    expect(parseSeeds("3")).toEqual([3]);
    expect(parseSeeds("1-3")).toEqual([1, 2, 3]);
    expect(parseSeeds("2,4")).toEqual([2, 4]);
    expect(parseSeeds("3-1")).toBeUndefined();
    expect(parseSeeds("a")).toBeUndefined();
  });
});

describe("crew expeditions: casts and plans", () => {
  it("leaves the default cast as authored", () => {
    expect(castFor(boathouseCast(), "default")).toEqual(boathouseCast());
  });

  it("makes every guard shaky and paid for the shaky cast, and nobody else", () => {
    const cast = castFor(boathouseCast(), "shaky");
    for (const e of cast.filter((c) => c.part === "guard")) {
      expect([e.resolve, e.tie]).toEqual(["shaky", "paid"]);
    }
    const others = (c: readonly SiteCastEntryDef[]) => c.filter((e) => e.part !== "guard");
    expect(others(cast)).toEqual(others(boathouseCast()));
  });

  it("makes the guards hard, devoted and armed with blasters up to the cap for the hard cast", () => {
    const cast = castFor(boathouseCast(), "hard");
    const guards = cast.filter((e) => e.part === "guard");
    expect(guards.map((e) => [e.name, e.resolve, e.tie, e.arms])).toEqual([
      ["Hesk Marrow", "hard", "devoted", "blaster"],
      ["Darrow Finch", "hard", "devoted", "blaster"],
    ]);
    expect(cast.filter((e) => e.arms !== "none").length).toBeLessThanOrEqual(3);
    expect(cast.find((e) => e.part === "target")?.arms).toBe("none");
  });

  it("takes the default pair, the lethal armed postures and assault on stun from the menu", () => {
    const [hold, assault] = DEFAULT_PLANS;
    if (hold === undefined || assault === undefined) throw new Error("no default pair");
    const option = (plan: PlanOption["plan"], available = true): PlanOption => ({
      id: plan.id,
      plan,
      available,
      why: "",
    });
    const menu = [
      option(hold),
      option(assault),
      option({ ...assault, id: "flank-lethal-armed", posture: "flank" }, false),
      option({ ...assault, id: "creep-lethal-armed", posture: "creep" }),
      option({ ...assault, id: "assault-stun-armed", fire: "stun" }),
      option({ ...hold, id: "hold-stun-armed", fire: "stun" }),
      option({ ...assault, id: "assault-lethal-small", squad: "smallTeam" }),
    ];
    expect(instrumentPlans(menu)).toEqual([
      "hold-lethal-armed",
      "assault-lethal-armed",
      "creep-lethal-armed",
      "assault-stun-armed",
    ]);
  });

  it("refuses a plan the site's menu does not offer", () => {
    const result = runExpeditionsCli(["--plans", "dance-lethal-armed", "--n", "1"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('plan "dance-lethal-armed" is not available at port.boathouse');
  });
});

function record(over: Partial<FightRecord>): FightRecord {
  const none = { graze: 0, serious: 0, grave: 0 };
  return {
    plan: "assault-lethal-armed",
    cast: "default",
    seed: 1,
    worldSeed: 10_000,
    outcome: "targetTaken",
    ending: "broke",
    musterToContactSeconds: 20,
    contactToEndSeconds: 30,
    party: 4,
    castFighters: 3,
    wounds: { us: none, them: { ...none, serious: 2 } },
    bystandersWounded: 0,
    down: { us: 0, them: 1 },
    dead: { us: 0, them: 0 },
    castFled: 1,
    castSurrendered: 1,
    shots: { us: 10, them: 4 },
    hits: { us: 3, them: 1 },
    partyWavered: 1,
    partyBroke: 0,
    tickerLines: 8,
    ...over,
  };
}

describe("crew expeditions: the summary", () => {
  it("gives shares, rates per fight and seconds over the fights that had them", () => {
    const s = summarise([
      record({}),
      record({
        outcome: "cutOff",
        ending: "timeout",
        musterToContactSeconds: null,
        contactToEndSeconds: null,
        shots: { us: 0, them: 0 },
        hits: { us: 0, them: 0 },
        castFled: 0,
        castSurrendered: 0,
      }),
    ]);
    expect(s.fights).toBe(2);
    expect(s.outcomes.targetTaken).toBe(0.5);
    expect(s.outcomes.cutOff).toBe(0.5);
    expect(s.endings.broke).toBe(0.5);
    expect(s.contactToEnd).toEqual({ mean: 30, min: 30, max: 30, of: 1 });
    expect(s.woundsPerFight.them.serious).toBe(2);
    expect(s.hitRate.us).toBeCloseTo(0.3);
    expect(s.castFledShare).toBeCloseTo(1 / 6);
    expect(s.partyWaveredShare).toBe(0.25);
  });
});

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
 * CI. Each plan runs in its own test (n 4 on seeds 1-2: eight fights) and the comparisons read both.
 */
describe("crew expeditions: CI bounds on the default cast (ruling 13)", () => {
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

  // enabled at integration once W2 lands
  it.skip("hold: few party deaths, never timed out", { timeout: 120_000 }, async () => {
    const hold = await runPlan("hold-lethal-armed");
    expect(deathsPerFight(hold)).toBeLessThanOrEqual(0.25);
    expect(hold.outcomes.timedOut + hold.outcomes.cutOff).toBe(0);
    expect(hold.outcomes.targetFled + hold.outcomes.targetTaken).toBeGreaterThanOrEqual(0.8);
  });

  // enabled at integration once W2 lands
  it.skip("assault: few party deaths, never timed out", { timeout: 120_000 }, async () => {
    const assault = await runPlan("assault-lethal-armed");
    expect(deathsPerFight(assault)).toBeLessThanOrEqual(0.25);
    expect(assault.outcomes.timedOut + assault.outcomes.cutOff).toBe(0);
    expect(assault.outcomes.targetTaken).toBeGreaterThanOrEqual(0.6);
  });

  // enabled at integration once W2 lands
  it.skip("hold costs fewer wounds and assault ends sooner", () => {
    const hold = summaryOf("hold-lethal-armed");
    const assault = summaryOf("assault-lethal-armed");
    expect(woundsPerFight(hold)).toBeLessThanOrEqual(0.75 * woundsPerFight(assault));
    expect(meanFight(assault)).toBeLessThanOrEqual(0.8 * meanFight(hold));
  });
});
