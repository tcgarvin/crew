import type {
  AgentViewSnapshot,
  LocalKey,
  RoleTag,
  Thought,
  ThoughtDef,
  ThoughtKey,
  Tick,
  WatchView,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  actorSubtitle,
  helmLine,
  moodWord,
  personWords,
  problemLines,
  rosterRole,
  thoughtText,
  topThoughts,
  watchLine,
} from "./actorWords";

const tags = (...names: string[]) => names as RoleTag[];

describe("actorSubtitle", () => {
  it("lists a crew member's role tags", () => {
    expect(actorSubtitle({ roleTags: tags("pilot", "medic") })).toBe("pilot, medic");
  });

  it("falls back to crew when there are no tags", () => {
    expect(actorSubtitle({ roleTags: [] })).toBe("crew");
  });

  it("says passenger for a passenger even without tags", () => {
    expect(actorSubtitle({ roleTags: [], passenger: true })).toBe("passenger");
  });

  it("says a disembarking passenger is going ashore", () => {
    expect(actorSubtitle({ roleTags: [], passenger: true, disembarking: true })).toBe(
      "passenger, going ashore",
    );
  });
});

describe("role and problem words (slice-2 QA)", () => {
  it("says a role in words, not its key", () => {
    expect(actorSubtitle({ roleTags: tags("firstOfficer") })).toBe("first officer");
    expect(rosterRole({ roleTags: tags("captain", "firstOfficer") })).toBe(
      "captain, first officer",
    );
  });

  it("lists each kind of known problem once, in words, with a count", () => {
    const kinds = [
      "cargoToLoad",
      "stationToStaff",
      "cargoToLoad",
      "cargoToLoad",
      "courseToPlot",
    ] as const;
    expect(problemLines(kinds.map((kind) => ({ kind }))).map((l) => l.text)).toEqual([
      "cargo to load ×3",
      "the helm to stand",
      "a course to plot",
    ]);
    expect(problemLines([])).toEqual([]);
  });
});

describe("rosterRole", () => {
  it("tags a passenger regardless of role tags", () => {
    expect(rosterRole({ roleTags: tags("pilot"), passenger: true })).toBe("passenger");
  });

  it("uses role tags for crew and crew when there are none", () => {
    expect(rosterRole({ roleTags: tags("engineer") })).toBe("engineer");
    expect(rosterRole({ roleTags: [] })).toBe("crew");
  });
});

const watch = (over: Partial<WatchView> = {}): WatchView => ({
  onWatch: false,
  dayworker: false,
  helmRole: "none",
  officerOfTheWatch: false,
  ...over,
});

describe("watchLine (D77)", () => {
  it("names the section and whether it has the watch", () => {
    const red = "red" as LocalKey;
    expect(watchLine({ watch: watch({ section: red, onWatch: true }), onDuty: true })).toBe(
      "Red section, on watch",
    );
    expect(watchLine({ watch: watch({ section: red }), onDuty: false })).toBe(
      "Red section, off watch",
    );
  });

  it("calls someone with no section a dayworker, on or off duty", () => {
    expect(watchLine({ watch: watch({ dayworker: true }), onDuty: true })).toBe(
      "Dayworker, on duty",
    );
    expect(watchLine({ watch: watch({ dayworker: true }), onDuty: false })).toBe(
      "Dayworker, off duty",
    );
  });
});

describe("helmLine (D77)", () => {
  it("says nothing for no helm role", () => {
    expect(helmLine(watch())).toBeUndefined();
  });

  it("names each helm role", () => {
    expect(helmLine(watch({ helmRole: "stander" }))).toBe("stands this watch's helm");
    expect(helmLine(watch({ helmRole: "oncoming" }))).toBe("has the helm next watch");
    expect(helmLine(watch({ helmRole: "relief" }))).toBe("can relieve the helm");
  });

  it("names the officer of the watch, with a helm role if they have one", () => {
    expect(helmLine(watch({ officerOfTheWatch: true }))).toBe("officer of the watch");
    expect(helmLine(watch({ officerOfTheWatch: true, helmRole: "relief" }))).toBe(
      "officer of the watch; can relieve the helm",
    );
  });
});

describe("moodWord (D79)", () => {
  const bands = { lowBelow: -0.4, highAbove: 0.4 };

  it("reads mood in three words at the config's bands", () => {
    expect(moodWord(-0.41, bands)).toBe("low");
    expect(moodWord(-0.4, bands)).toBe("steady");
    expect(moodWord(0, bands)).toBe("steady");
    expect(moodWord(0.4, bands)).toBe("steady");
    expect(moodWord(0.41, bands)).toBe("high");
  });
});

const DEFS: Readonly<Record<ThoughtKey, ThoughtDef>> = {
  stoodLongWatch: {
    key: "stoodLongWatch",
    label: "stood a long watch",
    value: -0.15,
    durationDays: 0.5,
    stacks: false,
  },
  doubleWatch: {
    key: "doubleWatch",
    label: "double watch",
    value: -0.25,
    durationDays: 1,
    stacks: false,
  },
  helmCleanPass: {
    key: "helmCleanPass",
    label: "brought the ship through clean",
    value: 0.1,
    durationDays: 0.3,
    stacks: true,
  },
  helmScrape: {
    key: "helmScrape",
    label: "scraped the ship through",
    value: -0.1,
    durationDays: 0.5,
    stacks: true,
  },
};

const thought = (key: ThoughtKey, value: number, expiresAtTick: number): Thought => ({
  key,
  value,
  expiresAtTick: expiresAtTick as Tick,
});

describe("topThoughts (D79)", () => {
  it("lists the strongest three, either sign, one line per key with a count", () => {
    const lines = topThoughts(
      [
        thought("helmCleanPass", 0.1, 500),
        thought("helmCleanPass", 0.1, 600),
        thought("helmCleanPass", 0.1, 700),
        thought("stoodLongWatch", -0.15, 500),
        thought("doubleWatch", -0.25, 500),
        thought("helmScrape", -0.1, 500),
      ],
      100 as Tick,
      DEFS,
    );
    expect(lines.map(thoughtText)).toEqual([
      "brought the ship through clean ×3",
      "double watch",
      "stood a long watch",
    ]);
    expect(lines[0]?.value).toBeCloseTo(0.3);
  });

  it("leaves out thoughts that have expired by the view's tick", () => {
    const lines = topThoughts(
      [thought("doubleWatch", -0.25, 100), thought("helmScrape", -0.1, 101)],
      100 as Tick,
      DEFS,
    );
    expect(lines.map((l) => l.key)).toEqual(["helmScrape"]);
  });

  it("is empty for someone with nothing on their mind", () => {
    expect(topThoughts([], 0 as Tick, DEFS)).toEqual([]);
  });
});

describe("personWords (D77, D79)", () => {
  it("puts the inspector's words together from the agent view", () => {
    const view = {
      tick: 10 as Tick,
      self: {
        mood: -0.5,
        onDuty: true,
        watch: watch({ section: "blue" as LocalKey, onWatch: true, helmRole: "stander" }),
        thoughts: [thought("doubleWatch", -0.25, 1000)],
      },
    } as unknown as AgentViewSnapshot;
    expect(personWords(view, DEFS, { lowBelow: -0.4, highAbove: 0.4 })).toEqual({
      watch: "Blue section, on watch",
      helm: "stands this watch's helm",
      mood: "low",
      thoughts: [{ key: "doubleWatch", label: "double watch", value: -0.25, count: 1 }],
    });
  });
});
