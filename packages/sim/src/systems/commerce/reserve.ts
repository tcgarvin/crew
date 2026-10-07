/**
 * D80: the stores the ship keeps aboard, bought at port like a part (D47) when they run low.
 *
 * Provisions (D81) are reckoned in days of meals (`systems/galley/provisions.ts`
 * `provisionsDays`: a crate a meal, a meal a watch, so crates over `time.watchesPerDay`). Under
 * `galley.lowBelowDays`, while docked at a port whose market sells a `provisions`-tagged item,
 * the crates that bring it to `galley.restockToDays` are a `reserveLow` problem for that item.
 * `galley.lowBelowDays` 0 turns it off.
 *
 * Food is reckoned in days of hunger: the nutrition of the `food` aboard over the people aboard
 * who eat (crew and passengers) times `needs.hungerPerDay`. Under
 * `commerce.foodReserve.lowBelowDays`, while docked at a port whose market sells food, the
 * shortfall to `restockToDays` is a `reserveLow` problem (owner commerce, public, routine) for
 * that food, and commerce derives the same `buyParts` task it derives for `partsNeeded`
 * (`tasks.ts`). Provisions are not `food` (nobody eats a crate) and a served meal is, so once the
 * galley cooks this rule keeps the ration packs, the fallback, stocked; the tuning commit sets how
 * many.
 *
 * Spares are reckoned in units: each `spare`-tagged item the market sells is kept at
 * `commerce.sparesReserve` units aboard, so a fault far from port finds its part in the hold.
 * A repair short of a part right now is `partsNeeded` (D47) and is bought on top of this.
 *
 * Patch kits (D93) are reckoned in units against what the scenario stocked: the `patchKit`-tagged
 * `startingItems` of `state.scenarioId` (two per locker, 24 on Mk2). With fewer kits aboard, a
 * market that sells a `patchKit` item (the first by id) is asked for the difference. Bought kits
 * come aboard like any purchase, set down at the top of the cargo ramp (`market.ts`), where a
 * patcher fetches them from as readily as from a locker.
 *
 * Raised, revised and settled against truth every tick, and only while docked at a port whose
 * market has the item in stock: underway, or where nothing is for sale, the crew can do nothing
 * about it, so there is no problem to show. The purchase settles it at the counter
 * (`market.ts`); the next tick's count against what is aboard confirms it.
 */
import { allocateId } from "../../core/ids";
import { effectiveMarket } from "../../core/markets";
import type { ItemDefId, PortDefId, ProblemId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { ProblemOfKind } from "../../core/types/work";
import { resolveProblem } from "../equipment/problems";
import { unitsAboard } from "../equipment/supplies";
import { cratesPerDay, provisionsDays, provisionsDefs } from "../galley/provisions";

type ReserveCtx = Pick<StepCtx, "content" | "config"> & {
  readonly state: Pick<ReadonlyWorldState, "items" | "jobs" | "actors" | "markets" | "scenarioId">;
};

/** One store the ship should buy more of here. */
export interface ReserveShortfall {
  readonly itemDefId: ItemDefId;
  readonly count: number;
}

/** People aboard who eat: crew and passengers who are neither dead nor off the ship. */
function eaters(state: ReserveCtx["state"]): number {
  return Object.values(state.actors).filter(
    (a) => a.crew && a.availability !== "dead" && a.availability !== "offShip",
  ).length;
}

/** Hunger the people aboard work off in a day. */
function hungerPerDay(ctx: ReserveCtx): number {
  return eaters(ctx.state) * ctx.config.needs.hungerPerDay;
}

/**
 * D80: days of food aboard at the current mouths (nutrition aboard over the day's hunger);
 * `Infinity` with nobody aboard to feed.
 */
export function foodDaysAboard(ctx: ReserveCtx): number {
  const perDay = hungerPerDay(ctx);
  if (perDay <= 0) return Number.POSITIVE_INFINITY;
  let nutrition = 0;
  for (const [defId, units] of unitsAboard(ctx.state)) {
    const def = ctx.content.items[defId];
    if (def?.tags.includes("food") !== true) continue;
    nutrition += units * (def.nutrition ?? 0);
  }
  return nutrition / perDay;
}

/** Units to buy for a fractional need, rounded up but not past float noise (14.000000000000002). */
function wholeUnits(need: number): number {
  return Math.ceil(need - 1e-9);
}

/** Item defs the market at `portId` has in stock, by id. */
function inStock(ctx: ReserveCtx, portId: PortDefId): ItemDefId[] {
  return Object.entries(effectiveMarket(ctx.state, ctx.content, portId))
    .filter(([, line]) => line.count > 0)
    .map(([defId]) => defId as ItemDefId)
    .sort();
}

/** The food to buy here, if food is low and the market sells some (the first by id). */
function foodShortfall(ctx: ReserveCtx, stock: readonly ItemDefId[]): ReserveShortfall[] {
  const { lowBelowDays, restockToDays } = ctx.config.commerce.foodReserve;
  const days = foodDaysAboard(ctx);
  if (days >= lowBelowDays) return [];
  const food = stock
    .map((defId) => ctx.content.items[defId])
    .find((def) => def?.tags.includes("food") === true && (def.nutrition ?? 0) > 0);
  if (food?.nutrition === undefined) return [];
  const units = wholeUnits(((restockToDays - days) * hungerPerDay(ctx)) / food.nutrition);
  return units > 0 ? [{ itemDefId: food.id, count: units }] : [];
}

/**
 * D81: the provisions to buy here, if the galley's days of meals are low and the market sells a
 * `provisions` item (the first by id): the crates that bring the days to `restockToDays`, a
 * crate a meal (`galley/provisions.ts`).
 */
function provisionsShortfall(ctx: ReserveCtx, stock: readonly ItemDefId[]): ReserveShortfall[] {
  const { lowBelowDays, restockToDays } = ctx.config.galley;
  if (lowBelowDays <= 0) return [];
  const days = provisionsDays(ctx.state, ctx.content, ctx.config);
  if (days >= lowBelowDays) return [];
  const sold = new Set(stock);
  const def = provisionsDefs(ctx.content).find((d) => sold.has(d.id));
  if (def === undefined) return [];
  const crates = wholeUnits((restockToDays - days) * cratesPerDay(ctx.config));
  return crates > 0 ? [{ itemDefId: def.id, count: crates }] : [];
}

/** Each `spare`-tagged item sold here that the ship holds fewer than the reserve of. */
function spareShortfalls(ctx: ReserveCtx, stock: readonly ItemDefId[]): ReserveShortfall[] {
  const reserve = ctx.config.commerce.sparesReserve;
  if (reserve <= 0) return [];
  const aboard = unitsAboard(ctx.state);
  const short: ReserveShortfall[] = [];
  for (const defId of stock) {
    if (ctx.content.items[defId]?.tags.includes("spare") !== true) continue;
    const missing = reserve - (aboard.get(defId) ?? 0);
    if (missing > 0) short.push({ itemDefId: defId, count: missing });
  }
  return short;
}

const isPatchKit = (ctx: ReserveCtx, defId: ItemDefId): boolean =>
  ctx.content.items[defId]?.tags.includes("patchKit") === true;

/** D93: the patch kits the scenario stocked the ship with (none when the scenario is unknown). */
export function stockedPatchKits(ctx: ReserveCtx): number {
  const scenario = ctx.content.scenarios[ctx.state.scenarioId];
  if (scenario === undefined) return 0;
  return scenario.startingItems
    .filter((line) => isPatchKit(ctx, line.itemDefId))
    .reduce((sum, line) => sum + line.count, 0);
}

/** D93: the kits that bring the ship back to its stocked count, if a market here sells them. */
function patchKitShortfall(ctx: ReserveCtx, stock: readonly ItemDefId[]): ReserveShortfall[] {
  const stocked = stockedPatchKits(ctx);
  if (stocked <= 0) return [];
  let aboard = 0;
  for (const [defId, units] of unitsAboard(ctx.state)) {
    if (isPatchKit(ctx, defId)) aboard += units;
  }
  const missing = stocked - aboard;
  const kit = stock.find((defId) => isPatchKit(ctx, defId));
  return missing > 0 && kit !== undefined ? [{ itemDefId: kit, count: missing }] : [];
}

/**
 * D80: what the ship should buy at `portId` to keep its reserves, among what the market there has
 * in stock. Empty when nothing is low or nothing that would help is for sale.
 */
export function reserveShortfalls(ctx: ReserveCtx, portId: PortDefId): ReserveShortfall[] {
  const stock = inStock(ctx, portId);
  return [
    ...provisionsShortfall(ctx, stock),
    ...foodShortfall(ctx, stock),
    ...spareShortfalls(ctx, stock),
    ...patchKitShortfall(ctx, stock),
  ];
}

const dedupeKeyOf = (itemDefId: ItemDefId): string => `reserveLow:${itemDefId}`;

function openReserveProblems(ctx: Pick<StepCtx, "state">): ProblemOfKind<"reserveLow">[] {
  return Object.values(ctx.state.work.problems).filter(
    (p): p is ProblemOfKind<"reserveLow"> => p.kind === "reserveLow" && p.status === "open",
  );
}

function raiseReserveLow(ctx: StepCtx, portId: PortDefId, shortfall: ReserveShortfall): void {
  const id = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[id] = {
    id,
    kind: "reserveLow",
    payload: { itemDefId: shortfall.itemDefId, count: shortfall.count },
    owner: "commerce",
    visibility: "public",
    dedupeKey: dedupeKeyOf(shortfall.itemDefId),
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "port", portId },
  };
}

/**
 * Keep `reserveLow` in step with the stores: open (revised to the live count) for each shortfall
 * at the port the ship is docked at; resolved once there is nothing left to buy here (the stores
 * are back up, the market sold out, or the ship has left).
 */
export function sweepReserves(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  const docked = travel.stage === "docked";
  const wanted = docked ? reserveShortfalls(ctx, travel.portId) : [];
  const byKey = new Map(wanted.map((s) => [dedupeKeyOf(s.itemDefId), s]));
  for (const problem of openReserveProblems(ctx)) {
    const shortfall = byKey.get(problem.dedupeKey);
    if (shortfall !== undefined) {
      byKey.delete(problem.dedupeKey);
      if (problem.payload.count !== shortfall.count) {
        problem.payload = { ...problem.payload, count: shortfall.count };
        problem.revision += 1;
      }
      continue;
    }
    // Resolved whether the stores are back up or the market here sold out: either way nothing is
    // left to buy, and (D63) a buyer still carrying a purchase aboard keeps their task.
    const event = resolveProblem(ctx.state, problem.dedupeKey);
    if (event !== undefined) ctx.emit(event);
  }
  if (!docked) return;
  for (const shortfall of byKey.values()) raiseReserveLow(ctx, travel.portId, shortfall);
}
