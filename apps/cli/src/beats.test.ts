import { loadBundle } from "@crew/content";
import { describe, expect, it } from "vitest";
import {
  type BeatEvent,
  BeatsTally,
  MESS_FULL_EATERS,
  type PersonSample,
  type ShipSample,
  activityClass,
  helmStood,
  parseBeatsArgs,
  recreationLabels,
} from "./beats";
import { crew } from "./index";

const ev = (type: string, tick: number, payload: object = {}) =>
  ({ type, tick, payload }) as BeatEvent;
const mara = (
  label: string,
  recreation = 0,
  soloActivityId: string | null = null,
): PersonSample => ({
  id: "actor:mara",
  name: "Mara Osei",
  label,
  recreation,
  soloActivityId,
});

/** The authored bundle's recreation labels. */
const RECREATION_LABELS = (() => {
  const result = loadBundle();
  if (!result.ok) throw new Error("content failed validation");
  return recreationLabels(result.bundle);
})();

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
    // §activities-and-interests: the activities' own labels, the fetch and the putting back.
    ["playing cards", "recreating"],
    ["waiting for a game of cards", "recreating"],
    ["playing solitaire", "recreating"],
    ["reading", "recreating"],
    ["baking", "recreating"],
    ["fetching a book", "recreating"],
    ["putting the book back", "recreating"],
    ["fetching the harmonica", "recreating"],
    ["putting the harmonica away", "recreating"],
  ])("%s → %s", (label, cls) => {
    expect(activityClass(label, RECREATION_LABELS)).toBe(cls);
  });
});

describe("the helm stood", () => {
  it("counts the stander eating in the seat as at the helm (§helm-plate)", () => {
    expect(helmStood(["idle", "at the helm, eating"])).toBe(true);
    expect(helmStood(["at the helm"])).toBe(true);
  });

  it("does not count walking to or from the helm", () => {
    expect(helmStood(["going to the helm", "leaving the helm", "taking a plate to the helm"])).toBe(
      false,
    );
  });
});

describe("the beats tally", () => {
  // Three watches of 100 ticks at 20 Hz, a day of three watches.
  // A meal's mess window of 40 ticks.
  const tally = () =>
    new BeatsTally(3, 100, 20, 3, 40, { seekThreshold: 0.5, labels: RECREATION_LABELS });
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
      ev("cargoBroken", 160),
      ev("bell", 300),
      ev("conversation", 250),
      ev("thoughtAdded", 10),
    ]);
    const { beats } = t.result();
    expect(beats.bells).toEqual({ total: 3, perWatchMean: 1, perWatchMin: 1, perWatchMax: 1 });
    expect(beats.handovers).toMatchObject({ total: 2, perWatchMin: 0, perWatchMax: 1 });
    expect(beats.hazards).toMatchObject({ total: 1, perWatchMax: 1 });
    expect(beats.cargoBroken).toMatchObject({ total: 1, perWatchMax: 1 });
    expect(beats.conversations.total).toBe(1);
    expect(beats.faults.total).toBe(0);
  });

  it("counts the galley and dirt beats: hot and ration meals apart, spoiled servings by count (§the-beats-instrument)", () => {
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
    const jax = (label: string): PersonSample => ({
      id: "actor:jax",
      name: "Jax",
      label,
      recreation: 0,
      soloActivityId: null,
    });
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

  it("counts sessions, outcomes and rivalry streaks per watch and sessions by activity (§group-sessions)", () => {
    const t = tally();
    t.events([
      ev("sessionOpened", 10, { sessionId: "s1", activityId: "activity.cards", hostId: "a1" }),
      ev("sessionStarted", 20, { sessionId: "s1", activityId: "activity.cards", memberIds: [] }),
      ev("sessionEnded", 90, { outcome: "contest", activityId: "activity.cards", winnerId: "a1" }),
      ev("sessionOpened", 110, { sessionId: "s2", activityId: "activity.cards", hostId: "a2" }),
      ev("sessionCollapsed", 140, { sessionId: "s2", activityId: "activity.cards", toSolo: true }),
      ev("sessionOpened", 150, { sessionId: "s3", activityId: "activity.debate", hostId: "a3" }),
      ev("sessionEnded", 160, { outcome: "debate", activityId: "activity.debate", argued: true }),
      ev("sessionEnded", 170, { outcome: "debate", activityId: "activity.debate", argued: false }),
      ev("sessionEnded", 180, { outcome: "abandoned", activityId: "activity.sparring" }),
      ev("sessionEnded", 190, { outcome: "perform", activityId: "activity.music" }),
      ev("sessionEnded", 195, { outcome: "bond", activityId: "activity.vids" }),
      ev("rivalryStreak", 250, { activityId: "activity.cards", streak: 3 }),
    ]);
    const r = t.result();
    expect(r.beats.sessionsOpened).toMatchObject({ total: 3, perWatchMin: 0, perWatchMax: 2 });
    expect(r.beats.sessionsStarted.total).toBe(1);
    expect(r.beats.sessionsCollapsed.total).toBe(1);
    expect(r.beats.sessionsAbandoned.total).toBe(1);
    expect(r.beats.contests.total).toBe(1);
    expect(r.beats.arguments.total).toBe(1);
    expect(r.beats.spiritedTalks.total).toBe(1);
    expect(r.beats.performances.total).toBe(1);
    expect(r.beats.rivalryStreaks.total).toBe(1);
    expect(r.byActivity).toEqual({
      "activity.cards": { opened: 2, started: 1, collapsed: 1, abandoned: 0, solo: 0 },
      "activity.debate": { opened: 1, started: 0, collapsed: 0, abandoned: 0, solo: 0 },
      "activity.sparring": { opened: 0, started: 0, collapsed: 0, abandoned: 1, solo: 0 },
    });
  });

  it("counts ticker lines in their watch, and refuses one past the last watch", () => {
    const t = tally();
    t.tickerLines([5, 50, 150].map((tick) => ({ tick, offWatch: false })));
    expect(t.result().beats.tickerLines).toMatchObject({ total: 3, perWatchMax: 2 });
    expect(() => t.tickerLines([{ tick: 301, offWatch: false }])).toThrow(
      /past the run's last watch/,
    );
  });

  it("counts the off-watch family's ticker lines apart, and among all lines (§the-beats-instrument)", () => {
    const t = tally();
    t.tickerLines([
      { tick: 5, offWatch: true },
      { tick: 50, offWatch: false },
      { tick: 150, offWatch: true },
      { tick: 160, offWatch: true },
    ]);
    const { beats } = t.result();
    expect(beats.tickerLines).toMatchObject({ total: 4, perWatchMax: 2 });
    expect(beats.offWatchLines).toMatchObject({ total: 3, perWatchMin: 0, perWatchMax: 2 });
  });

  it("counts a solo activity once when it begins, by kind, and the days someone recreated", () => {
    const t = tally();
    t.sample(20, [mara("playing solitaire", 0.6, "activity.cards")], { ...underway, tick: 20 });
    t.sample(20, [mara("playing solitaire", 0.4, "activity.cards")], { ...underway, tick: 40 });
    t.sample(20, [mara("reading", 0.3, "activity.reading")], { ...underway, tick: 60 });
    t.sample(20, [mara("idle", 0.3)], { ...underway, tick: 80 });
    t.sample(20, [mara("playing solitaire", 0.3, "activity.cards")], { ...underway, tick: 100 });
    const r = t.result();
    expect(r.beats.soloActivities.total).toBe(3);
    expect(r.byActivity["activity.cards"]?.solo).toBe(2);
    expect(r.byActivity["activity.reading"]?.solo).toBe(1);
    const person = r.people[0];
    expect(person?.shares.recreating).toBeCloseTo(80 / 100);
    expect(person?.daysRecreated).toBe(1);
  });

  it("finds the longest stretch bored, above the seek threshold and at the high mark", () => {
    const t = tally();
    t.sample(20, [mara("idle", 0.6)], { ...underway, tick: 20 });
    t.sample(20, [mara("idle", 0.85)], { ...underway, tick: 40 });
    t.sample(20, [mara("idle", 0.9)], { ...underway, tick: 60 });
    t.sample(20, [mara("playing cards", 0.5)], { ...underway, tick: 80 });
    t.sample(20, [mara("idle", 0.55)], { ...underway, tick: 100 });
    const person = t.result().people[0];
    expect(person?.longestBoredSeconds).toBe(3);
    expect(person?.longestVeryBoredSeconds).toBe(2);
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
      seeds: [1],
      scenarios: ["plain", "freight"],
      fields: "cycle",
      json: false,
    });
  });

  it("takes a seed range and a field plan (§the-beats-instrument)", () => {
    expect(parseBeatsArgs(["--seeds", "1-5", "--fields", "brutal"])).toMatchObject({
      seeds: [1, 2, 3, 4, 5],
      fields: "brutal",
    });
    expect(parseBeatsArgs(["--seed", "7"])).toMatchObject({ seeds: [7] });
    expect(parseBeatsArgs(["--seeds", "5-1"])).toHaveProperty("error");
    expect(parseBeatsArgs(["--fields", "apocalyptic"])).toHaveProperty("error");
  });

  it("refuses part days and unknown options", () => {
    expect(parseBeatsArgs(["--days", "1.5"])).toHaveProperty("error");
    expect(parseBeatsArgs(["--fast"])).toHaveProperty("error");
    expect(crew(["beats", "--days", "0"]).exitCode).toBe(1);
  });
});
