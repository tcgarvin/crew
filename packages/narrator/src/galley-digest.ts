/**
 * The galley and dirt in the digest (§ship-life-lines). Pure reads of the snapshot: the servings on
 * the `serving` zone and who cooked them, the next meal against the bell, the provisions aboard in
 * crates and days (`@crew/sim`'s own `provisionsCratesAboard` / `provisionsDays`, so the digest
 * says what commerce buys against), the rooms at `dirty` or worse from `state.dirt.tiers`, and
 * the problem lines for a provisions `reserveLow` and a `compartmentDirty`.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type DeepReadonly,
  type DirtTier,
  type ItemDefId,
  type LocalKey,
  type MealQuality,
  type Problem,
  type ProblemId,
  type RoleTag,
  cleaningRolesFor,
  dayTicks,
  provisionsCratesAboard,
  provisionsDays,
  stoveDown,
  watchTicks,
} from "@crew/sim";
import type { State } from "./lookups";

type Item = State["items"][keyof State["items"]];

/** The tiers the digest names a room at: the ones that raise `compartmentDirty`. */
const NAMED_TIERS: ReadonlySet<DirtTier> = new Set<DirtTier>(["dirty", "filthy"]);

function seconds(ticks: number, config: ConfigDef): number {
  return Math.round(ticks / config.time.tickRate);
}

function units(item: Item): number {
  return item.stacking === "stack" ? item.count : 1;
}

/** "about 5 days", "about 0.6 days": one decimal under two days, where a fraction matters. */
export function daysPhrase(days: number): string {
  if (!Number.isFinite(days)) return "nobody aboard to feed";
  const shown = days < 2 ? days.toFixed(1) : String(Math.round(days));
  return `about ${shown} days`;
}

/** The ship's deck tiles `${x},${y}` in zones tagged `tag`, per deck. */
function zoneTiles(state: State, content: ContentBundle, tag: string): Set<string> {
  const tiles = new Set<string>();
  for (const deckId of Object.keys(state.deck.tiles)) {
    const deck = content.decks[deckId as keyof ContentBundle["decks"]];
    if (deck === undefined) continue;
    for (const zone of deck.zones) {
      if (!zone.tags.includes(tag)) continue;
      for (const t of zone.tiles) tiles.add(`${deckId}/${t.x},${t.y}`);
    }
  }
  return tiles;
}

/** Served meals lying on the serving zone (the counter). */
function mealsOnCounter(state: State, content: ContentBundle): Item[] {
  const counter = zoneTiles(state, content, "serving");
  return Object.values(state.items)
    .filter((item) => {
      if (item.meal === undefined || item.location.kind !== "onDeck") return false;
      const { deckId, x, y } = item.location;
      return counter.has(`${deckId}/${Math.floor(x)},${Math.floor(y)}`);
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** "10 hot meals on the counter (good, Bettina Solheim)"; several cooks or qualities listed. */
function counterPhrase(state: State, content: ContentBundle): string {
  const meals = mealsOnCounter(state, content);
  const total = meals.reduce((sum, item) => sum + units(item), 0);
  if (total === 0) return "nothing on the counter";
  const groups = new Map<string, { quality: MealQuality; cook: string; count: number }>();
  for (const item of meals) {
    const meal = item.meal;
    if (meal === undefined) continue;
    const cook = state.actors[meal.cookId]?.name ?? meal.cookId;
    const key = `${meal.quality}/${cook}`;
    const group = groups.get(key) ?? { quality: meal.quality, cook, count: 0 };
    group.count += units(item);
    groups.set(key, group);
  }
  const list = [...groups.values()];
  const detail =
    list.length === 1
      ? `${list[0]?.quality}, ${list[0]?.cook}`
      : list.map((g) => `${g.count} ${g.quality}, ${g.cook}`).join("; ");
  return `${total} hot ${total === 1 ? "meal" : "meals"} on the counter (${detail})`;
}

/** Who holds a task derived from `problemId`, by name. */
export function taskHolders(state: State, problemId: ProblemId): string[] {
  const names: string[] = [];
  for (const task of Object.values(state.work.tasks)) {
    if (task.problemId !== problemId || task.claimState.kind !== "claimed") continue;
    for (const claimId of task.claimState.claimIds) {
      const owner = state.work.claims[claimId]?.ownerActorId;
      if (owner === undefined) continue;
      names.push(state.actors[owner]?.name ?? owner);
    }
  }
  return names.sort();
}

function openProblems<K extends Problem["kind"]>(
  state: State,
  kind: K,
): DeepReadonly<Extract<Problem, { kind: K }>>[] {
  return Object.values(state.work.problems).filter(
    (p): p is DeepReadonly<Extract<Problem, { kind: K }>> => p.kind === kind && p.status === "open",
  );
}

/**
 * The next meal against the bell. The galley raises `mealToCook` `mealLeadDays` before each bell
 * (§meal-problem): while one is open the meal is the coming bell's, said with who is cooking it;
 * past the call with none open, the coming bell's meal is served (or missed) and the next is the
 * bell after.
 */
function nextMealPhrase(state: State, config: ConfigDef): string {
  const length = watchTicks(config);
  const nextBell = (Math.floor(state.tick / length) + 1) * length;
  const cooking = openProblems(state, "mealToCook");
  const first = cooking.sort((a, b) => a.createdTick - b.createdTick)[0];
  if (first !== undefined) {
    const cooks = taskHolders(state, first.id);
    const who = cooks.length === 0 ? "nobody is cooking it yet" : `${cooks.join(", ")} cooking`;
    return `next meal due at the bell in ~${seconds(nextBell - state.tick, config)}s (${who})`;
  }
  const callTick = nextBell - dayTicks(config, config.galley.mealLeadDays);
  const bell = state.tick < callTick ? nextBell : nextBell + length;
  return `next meal due at the bell in ~${seconds(bell - state.tick, config)}s`;
}

/**
 * The Ship section's galley line: "galley: 10 hot meals on the counter (good, Bettina Solheim),
 * next meal due at the bell in ~90s; provisions 16 crates, about 5 days". While the stove is down
 * (§stove-down) it opens "galley: stove down, nothing cooks until it is repaired; ...". Undefined
 * when content has no `meal`-tagged item (no galley to speak of).
 */
export function galleyLine(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
): string | undefined {
  const hasGalley = Object.values(content.items).some((def) => def.tags.includes("meal"));
  if (!hasGalley) return undefined;
  const crates = provisionsCratesAboard(state, content);
  const days = provisionsDays(state, content, config);
  const provisions = `provisions ${crates} ${crates === 1 ? "crate" : "crates"}, ${daysPhrase(days)}`;
  const down = stoveDown(state, content, config)
    ? "stove down, nothing cooks until it is repaired; "
    : "";
  return `galley: ${down}${counterPhrase(state, content)}, ${nextMealPhrase(state, config)}; ${provisions}`;
}

/** A room's name from its compartment key on the ship's deck, or the key itself. */
export function roomName(state: State, content: ContentBundle, key: LocalKey): string {
  return roomDef(state, content, key)?.name ?? key;
}

function roomDef(state: State, content: ContentBundle, key: LocalKey) {
  for (const deckId of Object.keys(state.deck.tiles)) {
    const room = content.decks[deckId as keyof ContentBundle["decks"]]?.compartments.find(
      (c) => c.key === key,
    );
    if (room !== undefined) return room;
  }
  return undefined;
}

/** Role tags as the digest says them ("firstOfficer" reads "first officer"). */
const ROLE_WORDS: Readonly<Record<RoleTag, string>> = {
  captain: "captain",
  firstOfficer: "first officer",
  engineer: "engineer",
  pilot: "pilot",
  deckhand: "deckhand",
  cook: "cook",
  medic: "medic",
};

/**
 * Whose mop the room waits on (§who-mops `cleaningRolesFor`): "the deckhand's to mop", "anyone's to
 * mop".
 */
function whoseToMop(state: State, content: ContentBundle, key: LocalKey): string {
  const roles = cleaningRolesFor(roomDef(state, content, key)?.tags ?? []);
  if (roles.length === 0) return "anyone's to mop";
  return `the ${roles.map((r) => ROLE_WORDS[r]).join(" or ")}'s to mop`;
}

/**
 * The Ship section's dirt line, only while some room is at `dirty` or worse: "dirt: Cargo Hold
 * filthy; Galley & Mess dirty", filthy rooms first, then by name.
 */
export function dirtLine(state: State, content: ContentBundle): string | undefined {
  const rooms = Object.entries(state.dirt.tiers)
    .filter(([, tier]) => NAMED_TIERS.has(tier))
    .map(([key, tier]) => ({ name: roomName(state, content, key as LocalKey), tier }))
    .sort(
      (a, b) =>
        Number(b.tier === "filthy") - Number(a.tier === "filthy") || a.name.localeCompare(b.name),
    );
  if (rooms.length === 0) return undefined;
  return `dirt: ${rooms.map((r) => `${r.name} ${r.tier}`).join("; ")}`;
}

/** Is `itemDefId` a `provisions`-tagged item (the galley's stores, §galley-provisions)? */
export function isProvisions(content: ContentBundle, itemDefId: ItemDefId): boolean {
  return content.items[itemDefId]?.tags.includes("provisions") === true;
}

/**
 * §reserve-low-problem: a provisions `reserveLow` reads as the galley running low, in days of
 * meals, with the crates that restock it and why it is still open (`reason`, the digest's
 * `partsReason`).
 */
export function provisionsReserveDetail(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
  count: number,
  reason: string,
): string {
  const days = provisionsDays(state, content, config);
  return `provisions are low (${daysPhrase(days)} of meals left); ${count} ${count === 1 ? "crate" : "crates"} would restock the galley; ${reason}`;
}

/**
 * §ship-life-lines: "Cargo Hold is filthy; Dane Ruiz mopping" or "...; nobody is mopping it yet".
 */
export function compartmentDirtyDetail(
  state: State,
  content: ContentBundle,
  problem: DeepReadonly<Extract<Problem, { kind: "compartmentDirty" }>>,
): string {
  const name = roomName(state, content, problem.payload.key);
  const moppers = taskHolders(state, problem.id);
  const who =
    moppers.length === 0
      ? `nobody is mopping it yet, ${whoseToMop(state, content, problem.payload.key)}`
      : `${moppers.join(", ")} mopping`;
  return `${name} is ${problem.payload.tier}; ${who}`;
}
