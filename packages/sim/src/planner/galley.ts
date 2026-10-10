/**
 * The planner's galley rules (§mess-call): the eat candidate, the mess call, and who may take the
 * galley's tasks. Pure over the `AgentView`.
 *
 * - The mess call (`mealCallFor`): a served meal the actor knows of (not the helm-stander's plate,
 *   which lies within reach of a helm seat) and hunger above `galley.mealCallHungerAbove` make a
 *   routine eat candidate for anyone not on watch: a dayworker, the section off watch, and the
 *   section that stands the next watch, before its bell. The section on watch waits for the bell
 *   and eats as the off-going; its gangway stander comes (the hold ends for the call) and the
 *   gangway candidate waits until they have eaten (`helm.ts`). Same-class commitment does the
 *   rest: nobody is pulled off a crate, a plot or a sleep for dinner; they eat when it is done.
 * - `eatCandidate`: need-driven eating as before (past `needs.seekThreshold`, by need urgency),
 *   now preferring a served meal to a ration, plus the mess call at routine class. Slice 4 (call
 *   7): with neither, hunger above `galley.treatHungerAbove` and a known `treat` make a voluntary
 *   eat candidate, eaten where found (no table); a treat is never a hungry person's ration.
 * - `galleyTaskAllowed`: `cookMeal` is the cook's, and anyone's with cooking ≥ 1 once the problem
 *   is `galley.substituteAfterDays` old; `carryMeal` is the cook's or a dayworker's, anyone's after
 *   `urgency.routineAgingDays`, and never the stander's own. `galleyTaskExempt`: the cook on
 *   `cookMeal` skips the off-duty rule and `deferTo` (the helm's pattern, §who-has-the-helm): she
 *   cooks the third watch's meal off duty, sleeping in between.
 *
 * Owner: W1 of ship life slice 3.
 */
import type { TileCoord } from "../core/types/common";
import type { ConfigDef } from "../core/types/content";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, KnownItemView, ProblemView, TaskView } from "../core/types/view";
import type { UrgencyClass } from "../core/types/work";
import type { Candidate, Rejection } from "./candidates";
import {
  backingOff,
  inCompartmentTagged,
  inMyHands,
  loungeTile,
  needUrgency,
  personal,
} from "./common";

/** Is `task` one whose eligibility this file decides (`cookMeal`, `carryMeal`)? */
export function isGalleyTask(task: TaskView): boolean {
  return task.type === "cookMeal" || task.type === "carryMeal";
}

/** The galley's knobs: `PlannerConfig` carries the `galley` block (`core/pipeline.ts`). */
function galleyKnobs(config: PlannerConfig): ConfigDef["galley"] {
  return config.galley;
}

/**
 * A `Days` duration in ticks, inline because the planner may not import `core/clock`
 * (§the-ships-day).
 */
function dayTicksOf(config: PlannerConfig, days: number): number {
  return Math.ceil(days * config.time.daySeconds * config.time.tickRate);
}

const isRole = (view: AgentView, role: string): boolean =>
  view.self.roleTags.some((tag) => tag === role);

/** The helm seats: a plate within reach of one is the stander's. */
function helmSeats(view: AgentView): TileCoord[] {
  return view.schematic
    .amenities("pilotStation")
    .flatMap((m) => m.interactionTiles.filter((t) => t.purposes.includes("operate")))
    .map((t) => t.tile);
}

const withinArm = (a: TileCoord, b: TileCoord): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

/** Served meals the actor knows of on deck, reachable, not the stander's, not backing off. */
function knownMeals(view: AgentView): { item: KnownItemView; ticks: number }[] {
  const seats = helmSeats(view);
  const out: { item: KnownItemView; ticks: number }[] = [];
  for (const item of view.knownItems()) {
    if (item.absent || !item.tags.includes("meal") || item.tile === undefined) continue;
    const tile = item.tile;
    if (seats.some((seat) => withinArm(seat, tile))) continue;
    if (backingOff(view, `eat:${item.itemId}`)) continue;
    const ticks = view.estimateTravelTicks(tile);
    if (ticks !== null) out.push({ item, ticks });
  }
  return out.sort((a, b) => a.ticks - b.ticks || (a.item.itemId < b.item.itemId ? -1 : 1));
}

/**
 * The mess call for this actor: the known served meal they should go and eat now, if any (see the
 * module comment). Read by `helm.ts` to hold the gangway candidate back while it stands.
 */
export function mealCallFor(
  view: AgentView,
  config: PlannerConfig,
): { readonly itemId: KnownItemView["itemId"] } | undefined {
  const galley = galleyKnobs(config);
  if (galley === undefined || view.self.needs.hunger <= galley.mealCallHungerAbove) {
    return undefined;
  }
  const watch = view.self.watch;
  if (watch.onWatch && watch.gangway !== true) return undefined;
  const nearest = knownMeals(view)[0];
  return nearest === undefined ? undefined : { itemId: nearest.item.itemId };
}

/** May this actor take the galley task (see the module comment)? */
export function galleyTaskAllowed(
  view: AgentView,
  config: PlannerConfig,
  task: TaskView,
  problem: ProblemView,
): boolean {
  const age = view.tick - problem.createdTick;
  if (task.type === "cookMeal") {
    if (isRole(view, "cook")) return true;
    const galley = galleyKnobs(config);
    return galley !== undefined && age >= dayTicksOf(config, galley.substituteAfterDays);
  }
  if (problem.kind === "mealToCarry" && problem.payload.toActorId === view.self.id) return false;
  if (isRole(view, "cook") || view.self.watch.dayworker) return true;
  return age >= dayTicksOf(config, config.urgency.routineAgingDays);
}

/** Is the galley task exempt from the off-duty rule and `deferTo`? The cook's own meal is. */
export function galleyTaskExempt(view: AgentView, task: TaskView): boolean {
  return task.type === "cookMeal" && isRole(view, "cook");
}

export function eatCandidate(
  view: AgentView,
  config: PlannerConfig,
): Candidate | Rejection | undefined {
  const need = needUrgency(view.self.needs.hunger, config);
  const call = mealCallFor(view, config);
  if (need === undefined && call === undefined) return treatCandidate(view, config);
  const urgency: UrgencyClass = need ?? "routineObligation";
  const mealTicks = dayTicksOf(config, config.needs.mealDays);
  const food = view.knownItems().filter((i) => i.tags.includes("food") && !i.absent);
  const table = messTile(view);
  const toTable = (from?: TileCoord): number => {
    if (table === undefined) return 0;
    return view.estimateTravelTicks(table, from) ?? 0;
  };
  const atTable = table === undefined ? {} : { tile: table };
  const carried = food.filter((i) => inMyHands(view, i));
  // A ration in hand does not answer the mess call; a served meal in hand answers anything.
  const inHand =
    carried.find((i) => i.tags.includes("meal")) ?? (need === undefined ? undefined : carried[0]);
  if (inHand !== undefined) {
    return personal("eat", urgency, toTable() + mealTicks, view.tick, {
      kind: "personal",
      activity: "eat",
      itemId: inHand.itemId,
      ...atTable,
    });
  }
  const meals = knownMeals(view);
  const chosen =
    call === undefined
      ? (meals[0] ?? nearestRation(view, food))
      : meals.find((m) => m.item.itemId === call.itemId);
  if (chosen === undefined) return { ref: "eat", reason: "noKnownFood" };
  const fetch = chosen.ticks + toTable(chosen.item.tile);
  return personal(`eat:${chosen.item.itemId}`, urgency, fetch + mealTicks, view.tick, {
    kind: "personal",
    activity: "eat",
    itemId: chosen.item.itemId,
    ...atTable,
  });
}

/** The nearest reachable known food that is not a served meal (a ration), not backing off. */
function nearestRation(
  view: AgentView,
  food: readonly KnownItemView[],
): { item: KnownItemView; ticks: number } | undefined {
  let best: { item: KnownItemView; ticks: number } | undefined;
  for (const item of food) {
    if (item.tags.includes("meal") || item.tags.includes("treat")) continue;
    if (item.tile === undefined || backingOff(view, `eat:${item.itemId}`)) continue;
    const ticks = view.estimateTravelTicks(item.tile);
    if (ticks !== null && (best === undefined || ticks < best.ticks)) best = { item, ticks };
  }
  return best;
}

/** Slice 4: the nearest known treat, eaten where found, at voluntary class (call 7). */
function treatCandidate(view: AgentView, config: PlannerConfig): Candidate | undefined {
  if (view.self.needs.hunger <= galleyKnobs(config).treatHungerAbove) return undefined;
  let best: { item: KnownItemView; ticks: number } | undefined;
  for (const item of view.knownItems()) {
    if (item.absent || !item.tags.includes("treat") || item.tile === undefined) continue;
    if (backingOff(view, `eat:${item.itemId}`)) continue;
    const ticks = view.estimateTravelTicks(item.tile);
    if (ticks !== null && (best === undefined || ticks < best.ticks)) best = { item, ticks };
  }
  if (best === undefined) return undefined;
  const mealTicks = dayTicksOf(config, config.needs.mealDays);
  return personal(
    `eat:${best.item.itemId}`,
    "voluntaryActivity",
    best.ticks + mealTicks,
    view.tick,
    {
      kind: "personal",
      activity: "eat",
      itemId: best.item.itemId,
    },
  );
}

/**
 * W4a decision: people carry their food to the mess to eat when the ship has one (and they are
 * not already in it); otherwise they eat where they picked it up. §eating: the eat plan takes a
 * free mess seat over this spot when the ship has mess tables (`systems/galley/eat.ts`).
 */
function messTile(view: AgentView): TileCoord | undefined {
  const here = view.self.tile;
  if (
    here !== undefined &&
    (inCompartmentTagged(view, here, "mess") || inCompartmentTagged(view, here, "galley"))
  ) {
    return undefined;
  }
  return loungeTile(view, ["mess", "galley"]);
}
