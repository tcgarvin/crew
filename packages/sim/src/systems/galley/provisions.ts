/**
 * The provisions reserve, counted in days of meals (D81, reconciling D80's food rule).
 *
 * A crate of `provisions` makes `galley.servingsPerCrate` servings; a served `meal` on the counter
 * is one. Servings aboard over the people aboard who eat times `time.watchesPerDay` (a meal a
 * watch) is how many days the galley can cook for. Commerce's `reserveLow` (`commerce/reserve.ts`)
 * buys crates against `galley.lowBelowDays` / `restockToDays`; the digest and `crew beats` print
 * the days. Ration packs are not provisions: they stay D80's `commerce.foodReserve`, the fallback.
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

/** Servings aboard: the crates' worth plus served meals still on the counter or in hand. */
export function servingsAboard(
  state: ProvisionsState,
  content: ProvisionsContent,
  config: ConfigDef,
): number {
  const aboard = unitsAboard(state);
  let servings = provisionsCratesAboard(state, content) * config.galley.servingsPerCrate;
  const meal = mealDef(content);
  if (meal !== undefined) servings += aboard.get(meal.id) ?? 0;
  return servings;
}

/** Servings the people aboard eat in a day: one each per watch. */
export function servingsPerDay(
  state: Pick<ReadonlyWorldState, "actors">,
  config: ConfigDef,
): number {
  return eatersAboard(state) * config.time.watchesPerDay;
}

/**
 * Days of meals the galley can still cook (`servingsAboard` over `servingsPerDay`); `Infinity`
 * with nobody aboard to feed.
 */
export function provisionsDays(
  state: ProvisionsState,
  content: ProvisionsContent,
  config: ConfigDef,
): number {
  const perDay = servingsPerDay(state, config);
  if (perDay <= 0) return Number.POSITIVE_INFINITY;
  return servingsAboard(state, content, config) / perDay;
}
