/**
 * Eating (§eating): the `eat` plan, the `consume` commit point, the mess call's hold on the gangway
 * stander, and the `carryMeal` plan.
 *
 * - `eatPlan`: the food in hand, else one unit split off the stack the planner chose; then a free
 *   mess seat (a `use` position of a `messTable` machine nobody holds or is walking to, nearest
 *   the food: the reservation cache is truth, as plans may use it), else the floor spot the
 *   planner named, else where they stand; `mealDays` of eating, then `consume`. A seat taken on
 *   the way fails the walk (`occupiedPosition`), backs the meal off and the next plan takes
 *   another.
 * - `consumeServing` (the eat step's and the helm meal's commit): hunger falls by the item's
 *   `nutrition`; a served meal gives `ateWell` (good) or `burntDinner` (poor), food without a
 *   `meal` gives `ateRationPack`, a `treat` gives `ateATreat` and nothing else (slice 4); eating in a room at `dirty` / `filthy` gives `ateInDirtyMess` /
 *   `ateInFilthyMess`; a crumb of `eating` dirt where they are; `ateMeal` with `quality` and
 *   `ration`.
 * - `mealCallStandsFor`: a served meal they know of on deck (not the helm-stander's plate) and
 *   hunger above `galley.mealCallHungerAbove`; ends the gangway hold for dinner.
 * - `carryMealPlan`: one serving off the counter (or the one in hand) to the helm's standby tile,
 *   set down there.
 *
 * Owner: W1 of ship life slice 3.
 */
import { dayTicks } from "../../core/clock";
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { DeckDefId, ItemId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ActivityStep, StepTarget, Task } from "../../core/types/work";
import { depositDirt } from "../dirt/deposit";
import { type SeatOption, seatPreference } from "../social/seating";
import { reservationHolders, tileCapacity } from "../spatial/reservations";
import { backoffRef, isBackingOff } from "../work/activity";
import { emitSim } from "../work/events";
import { type PlanResult, acquireSteps, blocked, carriedItems, planOf } from "../work/plans";
import { type StepResult, touchInventory } from "../work/steps";
import { isMeal, positionTiles, roomTierAt, tileAt, withinArm } from "./kitchen";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

// ---------------------------------------------------------------------------------------------
// The eat plan
// ---------------------------------------------------------------------------------------------

const manhattan = (a: TileCoord, b: TileCoord): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Seats someone else's plan still has a walk to (`machineId:positionKey`): the reservation is only
 * taken when that walk starts, so a meal fetched first would otherwise pick a seat already spoken
 * for.
 */
function seatsSpokenFor(ctx: StepCtx, actor: Actor): Set<string> {
  const out = new Set<string>();
  for (const other of Object.values(ctx.state.actors)) {
    const activity = other.activity;
    if (other.id === actor.id || activity.kind === "idle" || activity.plan === undefined) continue;
    for (const step of activity.plan.steps.slice(activity.plan.stepIndex)) {
      if (step.kind === "moveTo" && "machineId" in step.target) {
        out.add(`${step.target.machineId}:${step.target.positionKey}`);
      }
    }
  }
  return out;
}

/**
 * The free mess seats on the actor's deck, nearest `from` first: `use` positions of `messTable`
 * machines nobody holds (the reservation cache: standing on it, or walking to it) or has planned
 * to walk to. A seat the actor already holds comes first of all (`held`). Slice 4: which one they
 * take is `seatPreference`'s (`systems/social/seating.ts`).
 */
function freeMessSeats(ctx: StepCtx, actor: Actor, from: TileCoord): SeatOption[] {
  if (actor.location.kind !== "onDeck") return [];
  const deckId = actor.location.deckId;
  const geometry = ctx.caches.nav.decks[deckId];
  if (geometry === undefined) return [];
  const spoken = seatsSpokenFor(ctx, actor);
  const seats: { seat: SeatOption; d: number }[] = [];
  for (const position of geometry.interactionPositions) {
    if (!position.purposes.includes("use")) continue;
    const machine = ctx.state.machines[position.machineId];
    if (machine === undefined || !ctx.content.machines[machine.defId]?.tags.includes("messTable")) {
      continue;
    }
    const holders = reservationHolders(ctx.caches, deckId, position.tile);
    const mine = holders.includes(actor.id);
    if (!mine && holders.length >= tileCapacity(geometry, position.tile)) continue;
    if (!mine && spoken.has(`${position.machineId}:${position.key}`)) continue;
    const d = mine ? -1 : manhattan(position.tile, from);
    const target = { machineId: position.machineId, positionKey: position.key };
    seats.push({ seat: { target, tile: { ...position.tile }, held: mine }, d });
  }
  // Stable: equally near seats keep the nav cache's order, as the single pick did.
  return seats.sort((a, b) => a.d - b.d).map(({ seat }) => seat);
}

const isTreat = (ctx: StepCtx, item: Item | undefined): boolean =>
  item !== undefined && ctx.content.items[item.defId]?.tags.includes("treat") === true;

/** Where the food is picked up from (its believed tile), else where the actor stands. */
function pickupFrom(ctx: StepCtx, actor: Actor, itemId: ItemId | undefined): TileCoord {
  const fact = itemId === undefined ? undefined : actor.knowledge[`${itemId}/itemLocation`];
  if (fact?.factType === "itemLocation" && fact.value.location.kind === "onDeck") {
    return tileAt(fact.value.location);
  }
  return actor.location.kind === "onDeck" ? tileAt(actor.location) : { x: 0, y: 0 };
}

/** Eat: get one unit (unless one is in hand), go to a mess seat (or `table`), eat, consume. */
export function eatPlan(
  ctx: StepCtx,
  actor: Actor,
  itemId: ItemId | undefined,
  table: TileCoord | undefined,
): PlanResult {
  const mealTicks = dayTicks(ctx.config, ctx.config.needs.mealDays);
  const carried = carriedItems(ctx, actor.id).filter((item) =>
    ctx.content.items[item.defId]?.tags.includes("food"),
  );
  // The unit named, else a served meal in hand (it does not keep); any food in hand only when the
  // planner named nothing to fetch (a ration in hand does not stand in for the meal on the counter).
  const inHand =
    carried.find((item) => item.id === itemId) ??
    carried.find((item) => item.meal !== undefined && isMeal(ctx.content, item)) ??
    (itemId === undefined ? carried[0] : undefined);
  const food = inHand ?? (itemId === undefined ? undefined : ctx.state.items[itemId]);
  // Slice 4 (call 7): a treat is eaten where it is found, not at the table.
  const seat = isTreat(ctx, food)
    ? undefined
    : seatPreference(
        ctx,
        actor,
        freeMessSeats(ctx, actor, pickupFrom(ctx, actor, inHand?.id ?? itemId)),
      )?.target;
  const to: StepTarget | undefined =
    seat ?? (table === undefined || isTreat(ctx, food) ? undefined : { ...table });
  const meal: ActivityStep[] = [
    ...(to === undefined ? [] : [{ kind: "moveTo", target: to, requested: false } as const]),
    { kind: "work", stage: "eat", ticksDone: 0, ticksNeeded: mealTicks },
  ];
  if (inHand !== undefined) return planOf([...meal, { kind: "consume", itemId: inHand.id }]);
  if (itemId === undefined) return blocked("inaccessibleSupply");
  const acquire = acquireSteps(ctx, actor, itemId, true);
  if (typeof acquire === "string") return blocked(acquire);
  return planOf([...acquire, ...meal, { kind: "consume", itemId }]);
}

// ---------------------------------------------------------------------------------------------
// Eating
// ---------------------------------------------------------------------------------------------

function deposit(ctx: StepCtx, deckId: DeckDefId, tile: TileCoord, amount: number): void {
  depositDirt(ctx.state, ctx.content, ctx.config, deckId, tile, amount);
}

/** The thoughts a meal gives: by its quality (or a ration's), and by the room it is eaten in. */
function mealThoughts(ctx: StepCtx, actor: Actor, item: Item): void {
  const quality = item.meal?.quality;
  if (quality === undefined) addThought(ctx, actor, "ateRationPack");
  else if (quality === "good") addThought(ctx, actor, "ateWell");
  else if (quality === "poor") addThought(ctx, actor, "burntDinner");
  const location = actor.location;
  if (location.kind !== "onDeck") return;
  const tier = roomTierAt(ctx.state, ctx.content, location.deckId, tileAt(location));
  if (tier === "filthy") addThought(ctx, actor, "ateInFilthyMess");
  else if (tier === "dirty") addThought(ctx, actor, "ateInDirtyMess");
}

/**
 * One unit of `item` is eaten by `actor` (see the module comment). The unit is gone: a stack's
 * count drops by one, anything else leaves state. Shared by the eat step and the helm meal.
 */
export function consumeServing(ctx: StepCtx, actor: Actor, item: Item): void {
  const nutrition = ctx.content.items[item.defId]?.nutrition ?? 1;
  actor.needs.hunger = Math.max(0, actor.needs.hunger - nutrition);
  if (item.stacking === "stack" && item.count > 1) item.count -= 1;
  else delete ctx.state.items[item.id];
  touchInventory(ctx);
  // Slice 4 (call 7): a treat is its own thought, whatever its `meal` says.
  if (isTreat(ctx, item)) addThought(ctx, actor, "ateATreat");
  else mealThoughts(ctx, actor, item);
  const location = actor.location;
  if (location.kind === "onDeck") {
    deposit(ctx, location.deckId, tileAt(location), ctx.config.dirt.deposits.eating);
  }
  const quality = item.meal?.quality;
  emitSim(ctx, "ateMeal", [actor.id, item.id], {
    nutrition,
    ...(quality === undefined ? {} : { quality }),
    ration: item.meal === undefined,
  });
}

/** The `consume` commit point: the carried unit named, else any carried food. */
export function runConsume(ctx: StepCtx, actor: Actor, step: StepOf<"consume">): StepResult {
  const carried = carriedItems(ctx, actor.id);
  const item =
    carried.find((i) => i.id === step.itemId) ??
    carried.find((i) => ctx.content.items[i.defId]?.tags.includes("food"));
  if (item === undefined) return { fail: "inaccessibleSupply" };
  consumeServing(ctx, actor, item);
  return "done";
}

// ---------------------------------------------------------------------------------------------
// The mess call and the helm's plate
// ---------------------------------------------------------------------------------------------

/** The tiles a plate for the helm-stander lies within reach of: each helm seat. */
export function helmSeatTiles(ctx: Pick<StepCtx, "state" | "content">): TileCoord[] {
  return Object.values(ctx.state.machines)
    .filter((m) => {
      const def = ctx.content.machines[m.defId];
      return def?.tags.includes("pilotStation") === true && def.operation.requiresOperator;
    })
    .flatMap((m) => positionTiles(ctx.state, ctx.content, m.id, "operate"));
}

/**
 * Served meals `actor` believes are on deck, outside arm's reach of a helm seat (that plate is
 * the stander's) and not backing off; `[tile, itemId]`, nearest first.
 */
export function knownMealsFor(
  ctx: Pick<StepCtx, "state" | "content" | "tick">,
  actor: Actor,
): { readonly itemId: ItemId; readonly tile: TileCoord }[] {
  const seats = helmSeatTiles(ctx);
  const here = actor.location.kind === "onDeck" ? tileAt(actor.location) : { x: 0, y: 0 };
  const out: { itemId: ItemId; tile: TileCoord; d: number }[] = [];
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation" || fact.value.absent === true) continue;
    const location = fact.value.location;
    if (location.kind !== "onDeck") continue;
    const itemId = fact.subjectId as ItemId;
    const item = ctx.state.items[itemId];
    if (item === undefined || !isMeal(ctx.content, item)) continue;
    const tile = tileAt(location);
    if (seats.some((seat) => withinArm(seat, tile))) continue;
    if (isBackingOff(actor.workBackoff, backoffRef.personal("eat", itemId), ctx.tick)) continue;
    out.push({ itemId, tile, d: manhattan(tile, here) });
  }
  out.sort((a, b) => a.d - b.d || (a.itemId < b.itemId ? -1 : 1));
  return out.map(({ itemId, tile }) => ({ itemId, tile }));
}

/**
 * Does the mess call stand for `actor`: a served meal they know of on deck (not the stander's
 * plate) and hunger above `galley.mealCallHungerAbove`? Ends the gangway hold
 * (`systems/watch/helm.ts`) for dinner; the planner's `mealCallFor` then sends them to it and
 * holds the gangway back until they have eaten.
 */
export function mealCallStandsFor(ctx: StepCtx, actor: Actor): boolean {
  if (actor.needs.hunger <= ctx.config.galley.mealCallHungerAbove) return false;
  return knownMealsFor(ctx, actor).length > 0;
}

/**
 * The `carryMeal` plan: a served meal in hand, else one split off the nearest counter stack the
 * carrier believes in (never the stander's own plate); to the helm's standby tile; set it down.
 * The split-off unit keeps the stack's `meal` and the plan's `putDown` is renamed to it by the
 * pick-up itself (`systems/work/steps.ts` `takeItem`/`runPickUp`).
 */
export function carryMealPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  const standby = task.interactionTiles[0];
  if (standby === undefined) return blocked("unreachableTarget");
  const toStandby: ActivityStep = {
    kind: "moveTo",
    target: { x: standby.x, y: standby.y },
    requested: false,
  };
  // Slice 4: a treat carries `meal` too (it spoils like a serving) but is nobody's plate.
  const inHand = carriedItems(ctx, actor.id).find(
    (item) => item.meal !== undefined && isMeal(ctx.content, item),
  );
  if (inHand !== undefined) return planOf([toStandby, { kind: "putDown", itemId: inHand.id }]);
  const [nearest] = knownMealsFor(ctx, actor);
  if (nearest === undefined) return blocked("inaccessibleSupply");
  const acquire = acquireSteps(ctx, actor, nearest.itemId, true);
  if (typeof acquire === "string") return blocked(acquire);
  return planOf([...acquire, toStandby, { kind: "putDown", itemId: nearest.itemId }]);
}
