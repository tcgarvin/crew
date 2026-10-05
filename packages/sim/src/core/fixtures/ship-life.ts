/**
 * Ship life slice 2 (D77-D79), slice 3 (D81-D82) and slice 4 content every hand-built fixture
 * bundle needs: the twenty-six thought defs (`ContentBundle.thoughts` is required), three of the
 * twelve activities and the seven topics (slice 4: `activities` and `topics` are required), and
 * the `watches`, `mood`, `hazards`, `galley`, `dirt`, `recreation`, `cabins` and slice 4 `social`
 * config at the default bundle's values. A fixture overrides `dayworkerOnWatches` to keep the
 * duty pattern its tests were written against.
 */
import type { ActivityDef, ConfigDef, ThoughtDef, ThoughtKey, TopicDef } from "../types/content";
import type { ActivityDefId, TopicDefId } from "../types/ids";

export const FIXTURE_THOUGHTS: Readonly<Record<ThoughtKey, ThoughtDef>> = {
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
};

const keyedById = <Id extends string, T extends { readonly id: Id }>(
  defs: readonly T[],
): Readonly<Record<Id, T>> => Object.fromEntries(defs.map((d) => [d.id, d])) as Record<Id, T>;

/**
 * Slice 4: three of the default bundle's twelve activities, one per outcome the fixtures exercise
 * (a contest, a fetched item, a solo machine). Tests add the others they need.
 */
export const FIXTURE_ACTIVITIES: Readonly<Record<ActivityDefId, ActivityDef>> = keyedById<
  ActivityDefId,
  ActivityDef
>([
  {
    id: "activity.cards" as ActivityDefId,
    label: "playing cards",
    waitingLabel: "waiting for a game of cards",
    interest: "cards",
    venue: [{ machineTag: "gamesTable" }, { compartmentTag: "lounge" }],
    participants: { min: 2, max: 4 },
    durationDays: 0.1,
    restores: { recreation: 0.4, social: 0.3 },
    solo: { label: "playing solitaire", durationDays: 0.06, restores: { recreation: 0.3 } },
    outcome: "contest",
    thoughts: { win: "wonContest", lose: "lostContest" },
    affinity: { participants: 1, winnerToLoser: 0, loserToWinner: -1 },
  },
  {
    id: "activity.reading" as ActivityDefId,
    label: "reading",
    waitingLabel: "reading",
    interest: "reading",
    venue: [{ machineTag: "desk", own: true }, { compartmentTag: "lounge" }],
    participants: { min: 1, max: 1 },
    durationDays: 0.08,
    restores: { recreation: 0.35, comfort: 0.1 },
    outcome: "none",
    requires: { itemTag: "book" },
  },
  {
    id: "activity.exercise" as ActivityDefId,
    label: "working out",
    waitingLabel: "working out",
    interest: "exercise",
    venue: [{ machineTag: "exerciseRig" }],
    participants: { min: 1, max: 1 },
    durationDays: 0.05,
    restores: { recreation: 0.3 },
    fatigueCost: 0.1,
    outcome: "none",
    dirt: 0.03,
  },
]);

/** Slice 4: the default bundle's seven topics. */
export const FIXTURE_TOPICS: Readonly<Record<TopicDefId, TopicDef>> = keyedById<
  TopicDefId,
  TopicDef
>(
  (
    [
      ["topic.the_guild", "the Guild", -1, 0, 0.5],
      ["topic.politics", "politics", 1, 0, -0.5],
      ["topic.faith", "faith", 0, -1, 0],
      ["topic.philosophy", "philosophy", 0.5, 0.5, 0],
      ["topic.the_league", "the League", 0, 0, 1],
      ["topic.old_captains", "the old captains", -0.5, 0, -0.5],
      ["topic.the_vid", "the vid", 0, 0, 0],
    ] as const
  ).map(([id, label, orderFreedom, faithReason, loyaltyAmbition]) => ({
    id: id as TopicDefId,
    label,
    weights: { orderFreedom, faithReason, loyaltyAmbition },
  })),
);

/** Slice 4: the default bundle's recreation block. */
export const FIXTURE_RECREATION: ConfigDef["recreation"] = {
  joinAbove: 0.25,
  gatherSeconds: 30,
  lateJoinSeconds: 20,
  collapseBackoffDays: 0.1,
};

/** Slice 4: the default bundle's affinity keys of the `social` block (each fixture keeps its chat). */
export const FIXTURE_SOCIAL: Omit<
  ConfigDef["social"],
  "chatRadiusTiles" | "chatCooldownSeconds" | "templateLines"
> = {
  chatAffinity: 1,
  chatAffinityEveryDays: 1,
  affinityRange: 10,
  avoidBelow: -3,
  preferAbove: 0,
  rivalry: { streakFor: 3 },
  debate: { agreeWithin: 2, argueBeyond: 4 },
};

/** Slice 4: the default bundle's cabins block. */
export const FIXTURE_CABINS: ConfigDef["cabins"] = {
  noisySeconds: 60,
  checkEverySeconds: 60,
  privateTalkSeconds: 20,
  privateTalkWaitSeconds: 120,
};

/** D81: the default bundle's galley block. `lowBelowDays` 0 keeps the provisions reserve off. */
export const FIXTURE_GALLEY: ConfigDef["galley"] = {
  mealLeadDays: 0.08,
  mealGraceDays: 0.1,
  cookSeconds: 30,
  substituteAfterDays: 0.025,
  spareServings: 1,
  servingsPerCrate: 12,
  mealSpoilDays: 0.25,
  mealCallHungerAbove: 0.2,
  lowBelowDays: 0,
  restockToDays: 0,
  goodCookingAbove: 6,
  poorCookingBelow: 3,
  treatHungerAbove: 0.1,
};

/** D82: the default bundle's dirt block. */
export const FIXTURE_DIRT: ConfigDef["dirt"] = {
  footfallPerStep: 0.004,
  bootsPickup: 0.15,
  bootsShed: 0.25,
  dockGrimePerStep: 0.08,
  airborneDustPerDay: 0.5,
  airborneDustRadiusTiles: 6,
  airborneDustVisitCap: 0.3,
  deposits: {
    cooking: 0.04,
    serving: 0.03,
    eating: 0.02,
    spoiledMeal: 0.08,
    repair: 0.05,
    cargo: 0.03,
  },
  depositRadiusTiles: 1,
  roomMaxWeight: 0.3,
  tiers: { untidy: 0.12, dirty: 0.3, filthy: 0.55 },
  tierHysteresis: 0.05,
  mopPerTile: 1,
  mopSecondsPerTile: 2,
  mopTilesPerTrip: 12,
  updateEverySeconds: 1,
  tintScale: 1.2,
  tintMaxAlpha: 0.35,
};

export function fixtureWatches(dayworkerOnWatches: readonly number[]): ConfigDef["watches"] {
  return {
    dayworkerOnWatches,
    handoverLeadSeconds: 30,
    handoverSeconds: 5,
    reliefMaxDays: 0.1,
    reliefNoShowSeconds: 45,
    longWatchFactor: 1.25,
    helmUnattendedSeconds: 20,
    roundsStopSeconds: 4,
    roundsEveryDays: 0.08,
    plotCourseSeconds: 20,
  };
}

export const FIXTURE_MOOD: ConfigDef["mood"] = {
  lowBelow: -0.4,
  highAbove: 0.4,
  lowWorkSpeed: 0.9,
  highWorkSpeed: 1.05,
};

export const FIXTURE_HAZARDS: ConfigDef["hazards"] = {
  difficulty: { easy: 3, hard: 5, brutal: 7 },
  delaySeconds: 60,
};
