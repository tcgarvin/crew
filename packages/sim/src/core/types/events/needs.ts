/** Needs and bodies events (W4a; body events are declared now, emitted once bodies exist). */
import type { NeedKey } from "../actor";
import type { MealQuality } from "../content";
import type { SignificanceCatalog } from "./significance";

export interface NeedsEventPayloads {
  needThresholdCrossed: {
    readonly need: NeedKey;
    readonly value: number;
    readonly rising: boolean;
  };
  fellAsleep: Record<string, never>;
  wokeUp: Record<string, never>;
  /**
   * Someone ate one unit. §eating: `quality` is the served meal's (absent for food without a
   * `meal`); `ration` says it was that fallback.
   */
  ateMeal: { readonly nutrition: number; readonly quality?: MealQuality; readonly ration: boolean };
  /**
   * W4a addition: ambient chat between two nearby off-duty/idle crew (subjects: speaker,
   * listener). `line` is the rendered ticker text. No relationship effects in V1.
   */
  conversation: { readonly line: string };
  actorIncapacitated: { readonly cause: string };
  actorDied: { readonly cause: string };
  /** Deferred with bodies (PLAN §7); reserved so the catalog matches SD §19.3. */
  woundCreated: { readonly bodyPart: string; readonly severity: number };
  treatmentApplied: { readonly bodyPart: string };
}

export const NEEDS_EVENT_SIGNIFICANCE = {
  needThresholdCrossed: "trace",
  fellAsleep: "trace",
  wokeUp: "trace",
  ateMeal: "trace",
  conversation: "notable",
  actorIncapacitated: "narrative",
  actorDied: "narrative",
  woundCreated: "narrative",
  treatmentApplied: "notable",
} as const satisfies SignificanceCatalog<NeedsEventPayloads>;
