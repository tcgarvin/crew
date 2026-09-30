/** Needs and bodies events (W4a; body events are declared now, emitted once bodies exist). */
import type { NeedKey } from "../actor";
import type { SignificanceCatalog } from "./significance";

export interface NeedsEventPayloads {
  needThresholdCrossed: {
    readonly need: NeedKey;
    readonly value: number;
    readonly rising: boolean;
  };
  fellAsleep: Record<string, never>;
  wokeUp: Record<string, never>;
  ateMeal: { readonly nutrition: number };
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
  actorIncapacitated: "narrative",
  actorDied: "narrative",
  woundCreated: "narrative",
  treatmentApplied: "notable",
} as const satisfies SignificanceCatalog<NeedsEventPayloads>;
