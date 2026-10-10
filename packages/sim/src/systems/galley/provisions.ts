/**
 * The provisions reserve, counted in days of meals (§galley-provisions).
 *
 * A crate of `provisions` is one meal: the serve uses the crate up and sets `servingsPerMeal`
 * servings on the counter (`cook.ts` `runServe`), whatever `galley.servingsPerCrate` says the
 * crate could have made; the rest is the waste of cooking for a crew. So the galley can cook for
 * `crates / time.watchesPerDay` days, plus the servings already on the counter or in hand as a
 * fraction of a meal. Counting the crates as servings (the gate's first reckoning) read eight days
 * for the eighteen crates the scenario stows and the ship ran dry in six without ever asking a
 * market, because the day the count fell under `galley.lowBelowDays` was the last.
 *
 * Commerce's `reserveLow` (`commerce/reserve.ts`) buys crates against `galley.lowBelowDays` /
 * `restockToDays`; the digest and `crew beats` print the days. Ration packs are not provisions:
 * they stay `commerce.foodReserve`, the fallback.
 *
 * Owner: W1 of ship life slice 3 (complete at the gate; W1 may extend, not rename).
 */
import type { ConfigDef, ContentBundle, ItemDef } from "../../core/types/content";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import { unitsAboard } from "../equipment/supplies";

type ProvisionsState = Pick<ReadonlyWorldState, "items" | "jobs" | "actors">;
type ProvisionsContent = Pick<ContentBundle, "items">;

/** People aboard who eat: crew (passengers included) neither dead nor off the ship. */
export function eatersAboard(state: Pick<ReadonlyWorldState, "actors">): number {
  return Object.values(state.actors).filter(
    (a) => a.crew && a.availability !== "dead" && a.availability !== "offShip",
  ).length;
}

/** The `provisions`-tagged item defs (what the galley cooks from), by id. */
export function provisionsDefs(content: ProvisionsContent): ItemDef[] {
  return Object.values(content.items)
    .filter((def) => def.tags.includes("provisions"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The one `meal`-tagged item def (what the galley serves), if content has it. */
export function mealDef(content: ProvisionsContent): ItemDef | undefined {
  return Object.values(content.items).find((def) => def.tags.includes("meal"));
}

/** Crates of provisions aboard (units over every `provisions` def). */
export function provisionsCratesAboard(state: ProvisionsState, content: ProvisionsContent): number {
  const aboard = unitsAboard(state);
  let crates = 0;
  for (const def of provisionsDefs(content)) crates += aboard.get(def.id) ?? 0;
  return crates;
}

/**
 * Servings a serve sets on the counter: everyone aboard who eats plus `galley.spareServings`,
 * never more than a crate makes, at least one.
 */
export function servingsPerMeal(
  state: Pick<ReadonlyWorldState, "actors">,
  config: Pick<ConfigDef, "galley">,
): number {
  const { spareServings, servingsPerCrate } = config.galley;
  return Math.max(1, Math.min(eatersAboard(state) + spareServings, servingsPerCrate));
}

/** Crates the galley cooks in a day: one a meal, a meal a watch. */
export function cratesPerDay(config: Pick<ConfigDef, "time">): number {
  return config.time.watchesPerDay;
}

/**
 * Days of meals the galley can still cook: the crates aboard, plus the served meals still on the
 * counter or in hand as a fraction of a meal, over the crates a day; `Infinity` with nobody
 * aboard to feed.
 */
export function provisionsDays(
  state: ProvisionsState,
  content: ProvisionsContent,
  config: Pick<ConfigDef, "galley" | "time">,
): number {
  if (eatersAboard(state) <= 0) return Number.POSITIVE_INFINITY;
  const meal = mealDef(content);
  const served = meal === undefined ? 0 : (unitsAboard(state).get(meal.id) ?? 0);
  const meals = provisionsCratesAboard(state, content) + served / servingsPerMeal(state, config);
  return meals / cratesPerDay(config);
}
