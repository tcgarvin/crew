/**
 * The galley system (D81), phase `needs`, every tick, registered after the watch (the bell
 * first, then the meal that follows it).
 *
 * W1 fills this in: raise `mealToCook` at `bell − galley.mealLeadDays` for the coming watch (once
 * per watch, `state.galley.lastMealWatch`), cancel it with `mealMissed` at `bell + mealGraceDays`;
 * sweep spoiled servings (`mealSpoiled`, a `spoiledMeal` deposit); emit `provisionsLow` when
 * `provisionsDays` falls under `galley.lowBelowDays` (the purchase itself is commerce's
 * `reserveLow`); raise and resolve `mealToCarry` for the helm-stander; run the helm meal
 * (`state.galley.helmMeal`, `needs.mealDays`, then `consumeServing`).
 *
 * Gate stub: a no-op, so nothing cooks until W1 lands.
 *
 * Owner: W1 of ship life slice 3.
 */
import type { System } from "../../core/types/pipeline";

export const galleySystem: System = {
  name: "galley",
  phase: "needs",
  run() {
    // W1: the meal rhythm (see the module comment).
  },
};
