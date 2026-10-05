import { describe, expect, it } from "vitest";
import {
  type BeatEvent,
  BeatsTally,
  MESS_FULL_EATERS,
  type PersonSample,
  type ShipSample,
  activityClass,
  formatBeatsReport,
  parseBeatsArgs,
  runBeats,
} from "./beats";
import { crew } from "./index";

const ev = (type: string, tick: number, payload: object = {}) =>
  ({ type, tick, payload }) as BeatEvent;
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
    ["leaving the helm", "walking"],
    ["going ashore to look for work", "ashore"],
    ["talking with Fenwick Adair", "ashore"],
    ["fetching provisions", "cooking"],
    ["cooking", "cooking"],
    ["serving dinner", "cooking"],
    ["taking a plate to the helm", "cooking"],
    ["at the helm, eating", "helm"],
    ["fetching the mop", "mopping"],
    ["mopping the Galley", "mopping"],
    ["putting the mop away", "mopping"],
    ["on station", "other"],
  ])("%s → %s", (label, cls) => {
    expect(activityClass(label)).toBe(cls);
  });
});

describe("the beats tally", () => {
  // Three watches of 100 ticks at 20 Hz, a day of three watches.
  // A meal's mess window of 40 ticks.
  const tally = () => new BeatsTally(3, 100, 20, 3, 40);
  const underway: ShipSample = {
    tick: 0,
    docked: false,
    helmEmpty: false,
    helmWatchOpen: true,
    cargoOpen: false,
    rooms: { dirty: 0, filthy: 0 },
  };

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

  it("counts the galley and dirt beats: hot and ration meals apart, spoiled servings by count (D83)", () => {
    const t = tally();
    t.events([
      ev("mealServed", 50, { servings: 10, quality: "good" }),
      ev("ateMeal", 55, { nutrition: 0.4, quality: "good", ration: false }),
      ev("ateMeal", 60, { nutrition: 0.4, quality: "good", ration: false }),
      ev("ateMeal", 120, { nutrition: 0.25, ration: true }),
      ev("mealMissed", 210, { watchIndex: 2 }),
      ev("mealSpoiled", 250, { count: 2 }),
      ev("roomFilthy", 130, {}),
      ev("roomCleaned", 180, {}),
      ev("roomDirty", 131, {}),
    ]);
    const { beats } = t.result();
    expect(beats.mealsServed).toMatchObject({ total: 1, perWatchMax: 1 });
    expect(beats.eatenHot.total).toBe(2);
    expect(beats.eatenRation.total).toBe(1);
    expect(beats.mealsMissed.total).toBe(1);
    expect(beats.servingsSpoiled).toMatchObject({ total: 2, perWatchMax: 2 });
    expect(beats.roomsFilthy.total).toBe(1);
    expect(beats.roomsCleaned.total).toBe(1);
  });

  it("counts the rooms dirty and filthy at each watch's last sample", () => {
    const t = tally();
    t.sample(50, [mara("idle")], { ...underway, tick: 50, rooms: { dirty: 3, filthy: 1 } });
    t.sample(50, [mara("idle")], { ...underway, tick: 100, rooms: { dirty: 1, filthy: 0 } });
    t.sample(100, [mara("idle")], { ...underway, tick: 200, rooms: { dirty: 2, filthy: 1 } });
    const { roomsAtWatchEnd } = t.result();
    expect(roomsAtWatchEnd.dirty).toEqual({
      total: 3,
      perWatchMean: 1,
      perWatchMin: 0,
      perWatchMax: 2,
    });
    expect(roomsAtWatchEnd.filthy).toMatchObject({ total: 1, perWatchMax: 1 });
  });

  it("measures how full the mess gets after each serve, within the window", () => {
    const t = tally();
    const hot = (tick: number) => ev("ateMeal", tick, { nutrition: 0.4, ration: false });
    t.events([
      ev("mealServed", 10, {}),
      ...Array.from({ length: MESS_FULL_EATERS }, (_, i) => hot(12 + i)),
      hot(60), // past the 40-tick window
      ev("mealServed", 110, {}),
      hot(115),
      ev("ateMeal", 116, { nutrition: 0.25, ration: true }),
    ]);
    expect(t.result().messFill).toEqual({
      serves: 2,
      meanEaters: (MESS_FULL_EATERS + 1) / 2,
      fewestEaters: 1,
      fullServes: 1,
    });
  });

  it("refuses an event past the run's last watch rather than dropping it", () => {
    expect(() => tally().events([ev("bell", 301)])).toThrow(/past the run's last watch/);
  });

  it("shares a person's time by class and finds their longest idle stretch", () => {
    const t = tally();
    t.sample(20, [mara("idle")], { ...underway, tick: 20 });
    t.sample(20, [mara("idle")], { ...underway, tick: 40 });
    t.sample(40, [mara("at the helm")], { ...underway, tick: 80 });
    t.sample(20, [mara("idle")], { ...underway, tick: 100, helmEmpty: true });
    t.sample(100, [mara("on station")], { ...underway, tick: 200 });
    const [person] = t.result().people;
    expect(person?.name).toBe("Mara Osei");
    expect(person?.shares.idle).toBeCloseTo(60 / 200);
    expect(person?.shares.helm).toBeCloseTo(40 / 200);
    expect(person?.longestIdleSeconds).toBe(2);
    expect(t.result().helmUnattendedSeconds).toBe(1);
    expect(t.result().otherLabels).toEqual({ "on station": 5 });
  });

  it("tallies port calls by watch of the day: cargo open, a stall while nobody hauls, and the gangway", () => {
    const t = tally();
    const docked = { ...underway, docked: true, helmWatchOpen: false, cargoOpen: true };
    const jax = (label: string): PersonSample => ({ id: "actor:jax", name: "Jax", label });
    // Watch 0: 2 s docked with cargo open, 1 s of it stalled, Jax on the gangway throughout.
    t.sample(20, [mara("idle"), jax("on the gangway")], { ...docked, tick: 20 });
    t.sample(20, [mara("hauling 2 crates"), jax("on the gangway")], { ...docked, tick: 40 });
    // Watch 2 (tick 201..300): 1 s docked with a course plotted (the helm watch, no gangway
    // wanted), cargo done, nobody on the gangway.
    t.sample(20, [mara("idle"), jax("at the helm")], {
      ...docked,
      tick: 220,
      cargoOpen: false,
      helmWatchOpen: true,
    });
    const { port } = t.result();
    expect(port).toHaveLength(3);
    expect(port[0]).toEqual({
      dockedSeconds: 2,
      cargoOpenSeconds: 2,
      cargoStallSeconds: 1,
      longestCargoStallSeconds: 1,
      gangwayWantedSeconds: 2,
      gangwaySeconds: 2,
    });
    expect(port[1]?.dockedSeconds).toBe(0);
    expect(port[2]).toMatchObject({
      dockedSeconds: 1,
      cargoOpenSeconds: 0,
      gangwayWantedSeconds: 0,
      gangwaySeconds: 0,
    });
  });

  it("records each sleep start as a day and a second of that day", () => {
    const t = tally();
    t.sample(20, [mara("idle")], { ...underway, tick: 20 });
    t.sample(20, [mara("asleep in her cabin")], { ...underway, tick: 40 });
    t.sample(20, [mara("asleep in her cabin")], { ...underway, tick: 60 });
    t.sample(20, [mara("idle")], { ...underway, tick: 80 });
    // A second sleep on the next day (a day is 300 ticks, 15 s).
    t.sample(20, [mara("asleep")], { ...underway, tick: 340 });
    expect(t.result().people[0]?.sleepStarts).toEqual([
      { day: 1, secondOfDay: 1 },
      { day: 2, secondOfDay: 1 },
    ]);
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
    // D81/D83: the cook serves a meal before each bell, so a day is three meals, none missed.
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

  it("reports at least one handover at the helm in a one-day run (D77)", () => {
    expect(oneDay().beats.handovers.total).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
