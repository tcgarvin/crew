/**
 * `crew expeditions` (expeditions A1): argument parsing, the cast variants, the plan choice and the
 * summary. The runs on the real content are in `expeditions.deep.test.ts`.
 */
import type { PlanOption, SiteCastEntryDef } from "@crew/sim";
import { DEFAULT_PLANS } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  type FightRecord,
  castFor,
  instrumentPlans,
  parseExpeditionsArgs,
  parseSeeds,
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
