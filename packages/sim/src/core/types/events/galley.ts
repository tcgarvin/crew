/**
 * Galley events (§galley-and-mess-call): the meal cooked, missed, spoiled or carried; the
 * provisions running low.
 */
import type { MealQuality } from "../content";
import type { ActorId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface GalleyEventPayloads {
  /** `cookId` served `servings` of `quality` on the counter (subjects: the cook, the servings). */
  mealServed: {
    readonly cookId: ActorId;
    readonly servings: number;
    readonly quality: MealQuality;
  };
  /** No meal was served for watch `watchIndex` by `galley.mealGraceDays` after its bell. */
  mealMissed: { readonly watchIndex: number };
  /** The galley swept `count` spoiled servings off the counter. */
  mealSpoiled: { readonly count: number };
  /** `byActorId` set a plate down at the helm for `toActorId`. */
  mealCarried: { readonly toActorId: ActorId; readonly byActorId: ActorId };
  /** Provisions aboard fell under `galley.lowBelowDays`: `crates` left, about `days` of meals. */
  provisionsLow: { readonly crates: number; readonly days: number };
}

export const GALLEY_EVENT_SIGNIFICANCE = {
  mealServed: "notable",
  mealMissed: "notable",
  mealSpoiled: "trace",
  mealCarried: "trace",
  // The digest sees it and it re-arms the quiet timer; not hooked (the next port's market answers).
  provisionsLow: "narrative",
} as const satisfies SignificanceCatalog<GalleyEventPayloads>;
