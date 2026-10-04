import type { SimEvent } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  BeatsTally,
  type PersonSample,
  activityClass,
  formatBeatsReport,
  parseBeatsArgs,
  runBeats,
} from "./beats";
import { crew } from "./index";

const ev = (type: string, tick: number) => ({ type, tick }) as Pick<SimEvent, "type" | "tick">;
const mara = (label: string): PersonSample => ({ id: "actor:mara", name: "Mara Osei", label });

describe("activity classes from canvas labels", () => {
  it.each([
    ["at the helm", "helm"],
    ["relieving Noor Haddad at the helm", "helm"],
    ["going to the helm", "helm"],
    ["plotting a course to Kessler Drift", "helm"],
    ["on the gangway", "gangway"],
    ["doing rounds", "rounds"],
    ["hauling 3 crates", "hauling"],
    ["stowing general freight crate", "hauling"],
    ["fetching the hand truck", "hauling"],
    ["fixing coolant pump", "repairing"],
    ["inspecting main engine", "repairing"],
    ["asleep in the captain's cabin", "asleep"],
    ["eating", "eating"],
    ["resting", "resting or chatting"],
    ["chatting with Jax Okonkwo", "resting or chatting"],
    ["idle", "idle"],
    ["walking to the mess", "walking"],
    ["coming aboard", "walking"],
    ["going ashore to look for work", "ashore"],
    ["talking with Fenwick Adair", "ashore"],
    ["on station", "other"],
  ])("%s → %s", (label, cls) => {
    expect(activityClass(label)).toBe(cls);
  });
});

describe("the beats tally", () => {
  // Three watches of 100 ticks at 20 Hz.
  const tally = () => new BeatsTally(3, 100, 20);

  it("counts each beat in the watch whose step produced it, the closing bell included", () => {
    const t = tally();
    t.events([
      ev("bell", 100),
      ev("helmRelieved", 95),
      ev("bell", 200),
      ev("helmRelieved", 201),
      ev("navHazard", 150),
      ev("bell", 300),
      ev("conversation", 250),
      ev("thoughtAdded", 10),
    ]);
    const { beats } = t.result();
    expect(beats.bells).toEqual({ total: 3, perWatchMean: 1, perWatchMin: 1, perWatchMax: 1 });
    expect(beats.handovers).toMatchObject({ total: 2, perWatchMin: 0, perWatchMax: 1 });
    expect(beats.hazards).toMatchObject({ total: 1, perWatchMax: 1 });
    expect(beats.conversations.total).toBe(1);
    expect(beats.faults.total).toBe(0);
  });

  it("refuses an event past the run's last watch rather than dropping it", () => {
    expect(() => tally().events([ev("bell", 301)])).toThrow(/past the run's last watch/);
  });

  it("shares a person's time by class and finds their longest idle stretch", () => {
    const t = tally();
    t.sample(20, [mara("idle")], false);
    t.sample(20, [mara("idle")], false);
    t.sample(40, [mara("at the helm")], false);
    t.sample(20, [mara("idle")], true);
    t.sample(100, [mara("on station")], false);
    const [person] = t.result().people;
    expect(person?.name).toBe("Mara Osei");
    expect(person?.shares.idle).toBeCloseTo(60 / 200);
    expect(person?.shares.helm).toBeCloseTo(40 / 200);
    expect(person?.longestIdleSeconds).toBe(2);
    expect(t.result().helmUnattendedSeconds).toBe(1);
    expect(t.result().otherLabels).toEqual({ "on station": 5 });
  });
});

describe("crew beats arguments", () => {
  it("defaults to three days, seed 1, both scenarios", () => {
    expect(parseBeatsArgs([])).toEqual({
      days: 3,
      seed: 1,
      scenarios: ["plain", "freight"],
      json: false,
    });
  });

  it("refuses part days and unknown options", () => {
    expect(parseBeatsArgs(["--days", "1.5"])).toHaveProperty("error");
    expect(parseBeatsArgs(["--fast"])).toHaveProperty("error");
    expect(crew(["beats", "--days", "0"]).exitCode).toBe(1);
  });
});

describe("crew beats: one ship's day of the pacing voyage (real content, every system)", () => {
  // One run for both pins below (a ship's day of the real game takes a while).
  let day: ReturnType<typeof runBeats> | undefined;
  const oneDay = () => {
    day ??= runBeats({ scenario: "freight", days: 1, seed: 1 });
    return day;
  };

  it("completes and rings three bells, one per watch", () => {
    const result = oneDay();
    expect(result.watches).toBe(3);
    expect(result.simSeconds).toBe(result.days * 3 * result.watchSeconds);
    expect(result.beats.bells).toMatchObject({ total: 3, perWatchMin: 1, perWatchMax: 1 });
    expect(result.people).toHaveLength(9);
    for (const person of result.people) {
      const sum = Object.values(person.shares).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1);
    }
    const report = formatBeatsReport([result]);
    expect(report).toContain("# Beats: 1 day, 3 watches of 400 s");
    expect(report).toContain("| bells | 3 | 1.00 | 1 | 1 |");
  }, 90_000);

  it("reports at least one handover at the helm in a one-day run (D77)", () => {
    expect(oneDay().beats.handovers.total).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
