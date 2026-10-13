/**
 * Ship life slice 2, slice 3, slice 4 and slice 5 (and expeditions A1) content every hand-built
 * fixture bundle needs: the thirty-two thought defs (`ContentBundle.thoughts` is required), three of the
 * twelve activities and the seven topics (slice 4: `activities` and `topics` are required), and
 * the `watches`, `mood`, `hazards`, `galley`, `dirt`, `recreation`, `cabins`, slice 4 `social` and
 * slice 5 `field`, `damage` and `intercom` and expeditions A1 `bodies` and `expedition` config at
 * the default bundle's values. A fixture overrides `dayworkerOnWatches` to keep the
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
    memories: { together: "goodTime", loserToWinner: "beatMe" },
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

/** §memories: the default bundle's memory table. */
export const FIXTURE_MEMORIES: ConfigDef["social"]["memories"] = {
  chatted: { label: "a good chat", opinion: 1, durationDays: 5, stackLimit: 2 },
  rubbedWrong: { label: "got on my nerves", opinion: -1, durationDays: 5, stackLimit: 2 },
  goodTime: { label: "a good time together", opinion: 1, durationDays: 3, stackLimit: 2 },
  beatMe: { label: "beat me", opinion: -1, durationDays: 3, stackLimit: 2 },
  keepsBeatingMe: { label: "keeps beating me", opinion: -1, durationDays: 3, stackLimit: 1 },
  goodTalk: { label: "a good talk", opinion: 2, durationDays: 5, stackLimit: 1 },
  argued: { label: "an argument", opinion: -2, durationDays: 5, stackLimit: 2 },
  playedForMe: { label: "played for me", opinion: 1, durationDays: 3, stackLimit: 1 },
  sharedATable: { label: "shared a table", opinion: 1, durationDays: 5, stackLimit: 1 },
  heardMeOut: { label: "heard me out", opinion: 2, durationDays: 7, stackLimit: 1 },
  dressedMeDown: { label: "dressed me down", opinion: -2, durationDays: 7, stackLimit: 1 },
  talkedItThrough: { label: "talked it through", opinion: 1, durationDays: 7, stackLimit: 1 },
  foughtBeside: { label: "fought beside me", opinion: 1, durationDays: 7, stackLimit: 2 },
  carriedMeOut: { label: "carried me out", opinion: 3, durationDays: 14, stackLimit: 1 },
  leftMeBehind: { label: "left me behind", opinion: -3, durationDays: 14, stackLimit: 1 },
  betrayedMe: { label: "betrayed me", opinion: -5, durationDays: 14, stackLimit: 1 },
  savedMyLife: { label: "saved my life", opinion: 5, durationDays: 14, stackLimit: 1 },
  wrongedOverSomeone: {
    label: "wronged me over someone",
    opinion: -4,
    durationDays: 10,
    stackLimit: 1,
  },
  madeItRight: { label: "made it right", opinion: 3, durationDays: 10, stackLimit: 1 },
};

/**
 * Slice 4: the default bundle's affinity keys of the `social` block (each fixture keeps its chat).
 * §affinity: compatibility weighs nothing and no chat sours, so a fixture's pair starts at 0 and
 * moves only by the memories its test gives; a test of compatibility sets its own.
 */
export const FIXTURE_SOCIAL: Omit<
  ConfigDef["social"],
  "chatRadiusTiles" | "chatCooldownSeconds" | "templateLines"
> = {
  chatMemoryEveryDays: 1,
  chatSour: { atZero: 0, perPoint: 0 },
  compatibility: { base: 0, perValuePoint: 0, perSharedLike: 0, perClash: 0, range: 2 },
  memories: FIXTURE_MEMORIES,
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

/**
 * §galley-provisions: the default bundle's galley block. `lowBelowDays` 0 keeps the provisions
 * reserve off.
 */
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

/** §dirt-grid: the default bundle's dirt block. */
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

/** Slice 5 (§the-asteroid-field): the asteroid field at the default bundle's values. */
export const FIXTURE_FIELD: ConfigDef["field"] = {
  warningSeconds: 12,
  alertClearSeconds: 60,
  severities: {
    light: { impactsPerMinute: 2, largeShare: 0.1, lengthSeconds: 90 },
    heavy: { impactsPerMinute: 4, largeShare: 0.25, lengthSeconds: 135 },
    brutal: { impactsPerMinute: 6, largeShare: 0.4, lengthSeconds: 180 },
  },
  helmThreading: 0.4,
  unmannedRateFactor: 1.5,
  stuckRateFactor: 0.7,
  stuckDriftImpacts: 6,
  hullDamage: { small: 3, large: 8 },
  machineEffects: { none: 25, graze: 25, damage: 25, knockout: 10, fault: 15 },
  effectIntegrity: { graze: 0.2, damage: 0.5 },
  patchRecovers: 0.5,
  maxScripted: 3,
  fragileBreakChance: { small: 0.1, large: 0.3 },
};

/** Slice 5 (§hull-scars-and-ship-loss): damage work at the default bundle's values. */
export const FIXTURE_DAMAGE: ConfigDef["damage"] = {
  patchSeconds: 20,
  plateSeconds: 40,
  repairSecondsPerIntegrity: 30,
  checkSeconds: 3,
};

/** Slice 5 (§intercom-and-reporting): the intercom at the default bundle's values. */
export const FIXTURE_INTERCOM: ConfigDef["intercom"] = { reportSeconds: 3 };

/** §medicine: treatment at the medbay bed at the default bundle's values. */
export const FIXTURE_MEDICAL: ConfigDef["medical"] = {
  treatSecondsPerWound: 15,
  kitsPerTreatment: 1,
  reserve: 2,
  giveUpAfterSeconds: 300,
  liftSeconds: 2,
  laySeconds: 2,
};

/** Expeditions A1 (§7.1): bodies at the default bundle's values. */
export const FIXTURE_BODIES: ConfigDef["bodies"] = {
  tolerance: { head: 2, torso: 3, leftArm: 2, rightArm: 2, leftLeg: 2, rightLeg: 2 },
  severityDamage: { graze: 0.5, serious: 1.2, grave: 2.5 },
  severityPain: { graze: 0.1, serious: 0.3, grave: 0.6 },
  painDecayPerSecond: 0.01,
  bleedPerSecond: { graze: 0, serious: 0.004, grave: 0.012 },
  bleedStopsAfterSeconds: { graze: 0, serious: 60, grave: 180 },
  bloodRecoverPerSecond: 0.002,
  stunPerHit: 0.5,
  stunDecayPerSecond: 0.004,
  incapacitatedBelow: { consciousness: 0.3, movement: 0.15 },
  deadBelowBlood: 0.25,
  healPerDay: 0.5,
  treatedHealFactor: 3,
  treatPainRelief: 0.3,
  partTable: { head: 10, torso: 45, leftArm: 10, rightArm: 10, leftLeg: 12.5, rightLeg: 12.5 },
  stunPartTable: { head: 0, torso: 0, leftArm: 25, rightArm: 25, leftLeg: 25, rightLeg: 25 },
};

/** Expeditions A1 (§8): the fight at the default bundle's values. */
export const FIXTURE_EXPEDITION: ConfigDef["expedition"] = {
  decideEverySeconds: 0.5,
  maxFightSeconds: 120,
  contactAfterSeconds: 15,
  maxApproachSeconds: 90,
  targetBoltsAfterSeconds: 60,
  guardSearchAfterSeconds: 10,
  alertClearSeconds: 60,
  hitSkillBase: 0.7,
  hitPerFighting: 0.06,
  rangeFalloffFloor: 0.5,
  coverPenalty: 0.5,
  movingTargetFactor: 0.8,
  movingShooterFactor: 0.7,
  resolveTiers: { shaky: 0.45, steady: 0.7, hard: 0.95 },
  tie: {
    paid: { resolve: 0.8, loyalty: 0.3 },
    bound: { resolve: 1, loyalty: 0.7 },
    devoted: { resolve: 1.25, loyalty: 1 },
  },
  castFighting: { shaky: 1, steady: 3, hard: 5 },
  crewResolve: { base: 0.6, perFighting: 0.03, perMood: 0.1, perLeaderAffinity: 0.02 },
  morale: {
    hitSelf: -0.25,
    allyDown: -0.2,
    allyDead: -0.3,
    underFireNoCoverPerSecond: -0.05,
    outnumberedPerSecond: -0.03,
    allyHit: 0.05,
    inCoverPerSecond: 0.02,
    leaderNearPerSecond: 0.02,
    outflanked: -0.3,
    targetTaken: -0.4,
    waverBelow: 0.5,
    breakBelow: 0.25,
    recoverAbove: 0.6,
  },
  withdrawWhen: { firstDown: 1, halfDown: 0.5 },
  leaderNearTiles: 3,
  surrenderIfCornered: true,
};
