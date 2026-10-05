/**
 * Ship life slice 2 (D77-D79) content every hand-built fixture bundle needs: the four thought
 * defs (`ContentBundle.thoughts` is required) and the `watches`, `mood` and `hazards` config
 * blocks at the default bundle's values. A fixture overrides `dayworkerOnWatches` to keep the duty
 * pattern its tests were written against.
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
