import type {
  ActorId,
  AgentViewSnapshot,
  EntityId,
  InterestTag,
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
  fillRef,
  helmLine,
  interestsLine,
  moodWord,
  personWords,
  problemLines,
  relationshipsLines,
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
  nextOnWatch: false,
  dayworker: false,
  helmRole: "none",
  officerOfTheWatch: false,
  ...over,
});

describe("watchLine (§sections-and-dayworkers)", () => {
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

describe("helmLine (§who-has-the-helm)", () => {
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

describe("moodWord (§mood-and-work-speed)", () => {
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
  ateWell: { key: "ateWell", label: "ate well", value: 0.1, durationDays: 0.3, stacks: false },
  burntDinner: {
    key: "burntDinner",
    label: "burnt dinner",
    value: -0.1,
    durationDays: 0.3,
    stacks: false,
  },
  ateRationPack: {
    key: "ateRationPack",
    label: "ate a ration pack",
    value: -0.05,
    durationDays: 0.3,
    stacks: false,
  },
  ateInDirtyMess: {
    key: "ateInDirtyMess",
    label: "ate in a dirty mess",
    value: -0.1,
    durationDays: 0.5,
    stacks: false,
  },
  ateInFilthyMess: {
    key: "ateInFilthyMess",
    label: "ate in a filthy mess",
    value: -0.2,
    durationDays: 0.5,
    stacks: false,
  },
  wonContest: {
    key: "wonContest",
    label: "won a game",
    value: 0.1,
    durationDays: 0.3,
    stacks: true,
  },
  lostContest: {
    key: "lostContest",
    label: "lost a game",
    value: -0.05,
    durationDays: 0.3,
    stacks: true,
  },
  keepsBeatingMe: {
    key: "keepsBeatingMe",
    label: "{ref} keeps beating me",
    value: -0.15,
    durationDays: 1,
    stacks: false,
  },
  goodCompany: {
    key: "goodCompany",
    label: "good company",
    value: 0.05,
    durationDays: 0.3,
    stacks: false,
  },
  spiritedTalk: {
    key: "spiritedTalk",
    label: "had a spirited talk",
    value: 0.1,
    durationDays: 0.5,
    stacks: false,
  },
  argued: {
    key: "argued",
    label: "argued with {ref}",
    value: -0.15,
    durationDays: 0.5,
    stacks: false,
  },
  gotLectured: {
    key: "gotLectured",
    label: "got lectured",
    value: -0.05,
    durationDays: 0.3,
    stacks: false,
  },
  enjoyedMusic: {
    key: "enjoyedMusic",
    label: "enjoyed the music",
    value: 0.1,
    durationDays: 0.3,
    stacks: false,
  },
  hatedTheNoise: {
    key: "hatedTheNoise",
    label: "hated the noise",
    value: -0.1,
    durationDays: 0.3,
    stacks: false,
  },
  sparringBruise: {
    key: "sparringBruise",
    label: "bruised from sparring",
    value: -0.1,
    durationDays: 0.5,
    stacks: false,
  },
  ownCabin: {
    key: "ownCabin",
    label: "a cabin of my own",
    value: 0.1,
    durationDays: 0.5,
    stacks: false,
  },
  noisyBunkroom: {
    key: "noisyBunkroom",
    label: "a noisy bunkroom",
    value: -0.1,
    durationDays: 0.5,
    stacks: false,
  },
  noBunkOfMyOwn: {
    key: "noBunkOfMyOwn",
    label: "no bunk of my own",
    value: -0.1,
    durationDays: 1,
    stacks: false,
  },
  satWithTheCaptain: {
    key: "satWithTheCaptain",
    label: "sat with the captain",
    value: 0.05,
    durationDays: 0.5,
    stacks: false,
  },
  heardOut: {
    key: "heardOut",
    label: "the captain heard me out",
    value: 0.1,
    durationDays: 1,
    stacks: false,
  },
  dressedDown: {
    key: "dressedDown",
    label: "dressed down by the captain",
    value: -0.15,
    durationDays: 1,
    stacks: false,
  },
  ateATreat: {
    key: "ateATreat",
    label: "ate a treat",
    value: 0.1,
    durationDays: 0.3,
    stacks: false,
  },
  nearMiss: {
    key: "nearMiss",
    label: "a rock came through a step away",
    value: -0.15,
    durationDays: 0.5,
    stacks: false,
  },
  killedSomeone: {
    key: "killedSomeone",
    label: "killed someone",
    value: -0.4,
    durationDays: 3,
    stacks: false,
  },
  sawCrewHurt: {
    key: "sawCrewHurt",
    label: "saw a crewmate hurt",
    value: -0.2,
    durationDays: 1,
    stacks: true,
  },
  heldTheLine: {
    key: "heldTheLine",
    label: "held the line",
    value: 0.2,
    durationDays: 1,
    stacks: false,
  },
  ranFromAFight: {
    key: "ranFromAFight",
    label: "ran from a fight",
    value: -0.2,
    durationDays: 1,
    stacks: false,
  },
  wounded: {
    key: "wounded",
    label: "wounded",
    value: -0.2,
    durationDays: 0.5,
    stacks: false,
  },
  fixedIt: {
    key: "fixedIt",
    label: "got a machine running again",
    value: 0.1,
    durationDays: 0.5,
    stacks: false,
  },
  cookedWell: {
    key: "cookedWell",
    label: "fed the crew well",
    value: 0.1,
    durationDays: 0.5,
    stacks: false,
  },
  bakedForTheCrew: {
    key: "bakedForTheCrew",
    label: "baked for the crew",
    value: 0.05,
    durationDays: 0.3,
    stacks: false,
  },
  nobodyJoinedIn: {
    key: "nobodyJoinedIn",
    label: "couldn't find anyone to join in",
    value: -0.05,
    durationDays: 0.25,
    stacks: false,
  },
  squaredAway: {
    key: "squaredAway",
    label: "left a room squared away",
    value: 0.05,
    durationDays: 0.3,
    stacks: false,
  },
  worriedAbout: {
    key: "worriedAbout",
    label: "worried about {ref}",
    value: -0.15,
    durationDays: 2,
    stacks: false,
  },
  grieving: {
    key: "grieving",
    label: "grieving for {ref}",
    value: -0.35,
    durationDays: 7,
    stacks: false,
  },
  shaken: {
    key: "shaken",
    label: "shaken",
    value: -0.2,
    durationDays: 1,
    stacks: false,
  },
  heartened: {
    key: "heartened",
    label: "heartened",
    value: 0.2,
    durationDays: 2,
    stacks: false,
  },
};

const thought = (
  key: ThoughtKey,
  value: number,
  expiresAtTick: number,
  refId?: string,
): Thought => ({
  key,
  value,
  expiresAtTick: expiresAtTick as Tick,
  ...(refId === undefined ? {} : { refId: refId as EntityId }),
});

describe("topThoughts (§thoughts)", () => {
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

  it("names the person a thought is about, one line per person (slice 4)", () => {
    const names = new Map([
      ["jax", "Jax Okonkwo"],
      ["priya", "Priya Kessler"],
    ]);
    const lines = topThoughts(
      [
        thought("keepsBeatingMe", -0.15, 500, "jax"),
        thought("argued", -0.15, 500, "priya"),
        thought("argued", -0.15, 500, "jax"),
      ],
      100 as Tick,
      DEFS,
      3,
      names,
    );
    expect(lines.map(thoughtText).sort()).toEqual([
      "Jax Okonkwo keeps beating me",
      "argued with Jax Okonkwo",
      "argued with Priya Kessler",
    ]);
  });
});

describe("fillRef (slice 4)", () => {
  it("fills the placeholder with the name", () => {
    expect(fillRef("{ref} keeps beating me", "Jax Okonkwo")).toBe("Jax Okonkwo keeps beating me");
  });

  it("says someone for a person the roster no longer has", () => {
    expect(fillRef("argued with {ref}", undefined)).toBe("argued with someone");
  });

  it("leaves a label with no placeholder alone", () => {
    expect(fillRef("ate a treat", "Jax Okonkwo")).toBe("ate a treat");
  });
});

describe("interestsLine (slice 4)", () => {
  const i = (...t: string[]) => t as InterestTag[];

  it("leads with the strong like, marked keen, then the dislikes", () => {
    expect(
      interestsLine({ likes: i("vids", "cards"), strong: "cards", dislikes: i("reading") }),
    ).toBe("likes cards (keen), vids; dislikes reading");
  });

  it("says the tags in words", () => {
    expect(interestsLine({ likes: i("boardgames"), dislikes: [] })).toBe("likes board games");
  });

  it("gives only the dislikes for someone with no likes, and says when there is nothing", () => {
    expect(interestsLine({ likes: [], dislikes: i("exercise") })).toBe("dislikes exercise");
    expect(interestsLine({ likes: [], dislikes: [] })).toBe("nothing in particular");
  });
});

describe("relationshipsLines (slice 4)", () => {
  const roster = [
    { actorId: "jax" as ActorId, name: "Jax Okonkwo" },
    { actorId: "tomas" as ActorId, name: "Tomas Ruiz" },
    { actorId: "dane" as ActorId, name: "Dane Whitcross" },
    { actorId: "priya" as ActorId, name: "Priya Kessler" },
    { actorId: "noor" as ActorId, name: "Noor Haddad" },
    { actorId: "mara" as ActorId, name: "Mara Osei" },
  ];
  const affinity = (entries: Record<string, number>) =>
    entries as Readonly<Record<ActorId, number>>;

  it("names the two closest and the two most at odds, strongest first", () => {
    expect(
      relationshipsLines(
        affinity({ jax: 4, tomas: 6, dane: 3, priya: -3, noor: -7, mara: -5 }),
        roster,
      ),
    ).toEqual([
      "close to Tomas Ruiz (+6)",
      "close to Jax Okonkwo (+4)",
      "at odds with Noor Haddad (−7)",
      "at odds with Mara Osei (−5)",
    ]);
  });

  it("leaves out passing acquaintance, and anyone no longer aboard", () => {
    expect(relationshipsLines(affinity({ jax: 2, priya: -2, gone: 9 }), roster)).toEqual([]);
  });
});

describe("personWords (§sections-and-dayworkers, §mood-and-work-speed)", () => {
  it("puts the inspector's words together from the agent view", () => {
    const view = {
      tick: 10 as Tick,
      self: {
        mood: -0.5,
        onDuty: true,
        watch: watch({ section: "blue" as LocalKey, onWatch: true, helmRole: "stander" }),
        thoughts: [thought("doubleWatch", -0.25, 1000)],
        interests: { likes: ["cards"], strong: "cards", dislikes: [] },
        affinity: { jax: 4 },
      },
      roster: [{ actorId: "jax", name: "Jax Okonkwo" }],
    } as unknown as AgentViewSnapshot;
    expect(personWords(view, DEFS, { lowBelow: -0.4, highAbove: 0.4 })).toEqual({
      watch: "Blue section, on watch",
      helm: "stands this watch's helm",
      mood: "low",
      thoughts: [{ key: "doubleWatch", label: "double watch", value: -0.25, count: 1 }],
      interests: "likes cards (keen)",
      relationships: ["close to Jax Okonkwo (+4)"],
    });
  });
});
