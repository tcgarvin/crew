/**
 * Ship life slice 2 (D77-D79) and slice 3 (D81-D82) content every hand-built fixture bundle
 * needs: the nine thought defs (`ContentBundle.thoughts` is required) and the `watches`, `mood`,
 * `hazards`, `galley` and `dirt` config blocks at the default bundle's values. A fixture overrides
 * `dayworkerOnWatches` to keep the duty pattern its tests were written against.
 */
import type { ConfigDef, ThoughtDef, ThoughtKey } from "../types/content";

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
