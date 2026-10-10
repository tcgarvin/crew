/**
 * Cooking and serving (§cooking-and-serving): the `cookMeal` plan and its two commit steps.
 *
 * - `cookPlan`: a crate of provisions in hand already, else one split off the nearest stack the
 *   cook believes in (`pickUp` with `split`: the generic supply steps carry whole stacks, and
 *   eighteen crates walking to the stove is not the picture) → the stove's `use` position →
 *   `work cook` for `galley.cookSeconds` at the cook's skill rate (`workRate`) → the `serving`
 *   zone's first tile → `serve`. Blocked `inaccessibleSupply` when the cook knows of no provisions:
 *   the task backs off and the meal is missed at its grace.
 * - `runCook` counts the stove time and leaves the `cooking` deposit on the stove's tile when done.
 * - `runServe` is the commit: the carried crate is used up and `crewAboard + spareServings`
 *   servings (never more than `servingsPerCrate`) are set on the counter as one stack with
 *   `Item.meal` (quality from the cook's skill and the galley's tier, spoiling `mealSpoilDays` on);
 *   every crew member aboard is told where it is (the mess call); `mealServed`, a `serving`
 *   deposit, `mealToCook` resolved; and `provisionsLow` when that crate took the galley's days of
 *   cooking under `galley.lowBelowDays` (the purchase is commerce's `reserveLow`).
 *
 * Owner: W1 of ship life slice 3.
 */
import { configTicks, dayTicks } from "../../core/clock";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { DeckDefId, ItemId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item, StackItem } from "../../core/types/ship";
import type { ActivityStep, ProblemOfKind, Task } from "../../core/types/work";
import { depositDirt } from "../dirt/deposit";
import { emitSim } from "../work/events";
import { writeFact } from "../work/facts";
import { awaitsFamiliarityBrief } from "../work/perception";
import {
  type PlanResult,
  acquireSteps,
  blocked,
  carriedItems,
  interactionTarget,
  planOf,
} from "../work/plans";
import { type StepResult, touchInventory, workRate } from "../work/steps";
import { mealQuality, positionTiles, roomTierAt, servingTiles, tileAt, unitsOf } from "./kitchen";
import {
  cratesPerDay,
  mealDef,
  provisionsCratesAboard,
  provisionsDays,
  servingsPerMeal,
} from "./provisions";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

const isProvisions = (ctx: Pick<StepCtx, "content">, item: Pick<Item, "defId">): boolean =>
  ctx.content.items[item.defId]?.tags.includes("provisions") === true;

/** The crate of provisions the actor has in hand, if any. */
function provisionsInHand(ctx: StepCtx, actor: Actor): Item | undefined {
  return carriedItems(ctx, actor.id).find((item) => isProvisions(ctx, item));
}

/** The provisions the actor believes are on deck, nearest first (Manhattan), then by id. */
function knownProvisions(ctx: StepCtx, actor: Actor): ItemId[] {
  const here = actor.location.kind === "onDeck" ? tileAt(actor.location) : { x: 0, y: 0 };
  const found: { itemId: ItemId; d: number }[] = [];
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation" || fact.value.absent === true) continue;
    const location = fact.value.location;
    if (location.kind !== "onDeck") continue;
    const itemId = fact.subjectId as ItemId;
    // What the item is comes from truth, as in the planner's view; where it is, is belief.
    const item = ctx.state.items[itemId];
    if (item === undefined || !isProvisions(ctx, item)) continue;
    const tile = tileAt(location);
    found.push({ itemId, d: Math.abs(tile.x - here.x) + Math.abs(tile.y - here.y) });
  }
  found.sort((a, b) => a.d - b.d || (a.itemId < b.itemId ? -1 : 1));
  return found.map((f) => f.itemId);
}

/** The `cookMeal` plan (see the module comment). */
export function cookPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "machine" || actor.location.kind !== "onDeck") {
    return blocked("unreachableTarget");
  }
  const stove = interactionTarget(ctx, actor, task.target.machineId, "use");
  const counter = servingTiles(ctx.content, actor.location.deckId)[0];
  if (stove === undefined || counter === undefined) return blocked("unreachableTarget");
  const steps: ActivityStep[] = [];
  if (provisionsInHand(ctx, actor) === undefined) {
    const [stockId] = knownProvisions(ctx, actor);
    if (stockId === undefined) return blocked("inaccessibleSupply");
    const acquire = acquireSteps(ctx, actor, stockId, true);
    if (typeof acquire === "string") return blocked(acquire);
    steps.push(...acquire);
  }
  const cookTicks = Math.max(1, configTicks(ctx.config, ctx.config.galley.cookSeconds));
  return planOf([
    ...steps,
    { kind: "moveTo", target: stove, requested: false },
    { kind: "work", stage: "cook", ticksDone: 0, ticksNeeded: cookTicks },
    { kind: "moveTo", target: { x: counter.x, y: counter.y }, requested: false },
    { kind: "serve" },
  ]);
}

function taskOf(ctx: StepCtx, actor: Actor): Task | undefined {
  const activity = actor.activity;
  return activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
}

function openMealProblem(ctx: StepCtx, task: Task): ProblemOfKind<"mealToCook"> | undefined {
  const problem = ctx.state.work.problems[task.problemId];
  return problem?.kind === "mealToCook" && problem.status === "open" ? problem : undefined;
}

function deposit(ctx: StepCtx, deckId: DeckDefId, tile: TileCoord, amount: number): void {
  depositDirt(ctx.state, ctx.content, ctx.config, deckId, tile, amount);
}

/** The `work cook` stage at the stove: the cook's skill rate per tick; a `cooking` deposit at the end. */
export function runCook(ctx: StepCtx, actor: Actor, step: StepOf<"work">): StepResult {
  const task = taskOf(ctx, actor);
  if (task === undefined || openMealProblem(ctx, task) === undefined) {
    return { fail: "dependencyPending" };
  }
  if (provisionsInHand(ctx, actor) === undefined) return { fail: "inaccessibleSupply" };
  if (task.status === "claimed") task.status = "active";
  step.ticksDone += workRate(ctx, actor, task);
  if (step.ticksDone < step.ticksNeeded) return "wait";
  if (actor.location.kind === "onDeck") {
    deposit(ctx, actor.location.deckId, tileAt(actor.location), ctx.config.dirt.deposits.cooking);
  }
  return "done";
}

/** Use one unit of a carried stack (or the whole item): it is gone. */
function useUp(ctx: StepCtx, item: Item): void {
  if (item.stacking === "stack" && item.count > 1) item.count -= 1;
  else delete ctx.state.items[item.id];
}

/** Tell every crew member aboard where the servings are (a report, like the dropped tools). */
function callTheMess(ctx: StepCtx, cook: Actor, servings: StackItem): void {
  const source = {
    tick: ctx.tick,
    sourceId: cook.id,
    evidence: "report",
    certainty: "reported",
  } as const;
  for (const other of Object.values(ctx.state.actors)) {
    if (!other.crew || other.availability === "dead" || other.availability === "offShip") continue;
    // Their first look's familiarity brief covers it; a fact written first would stop that brief.
    if (other.id !== cook.id && awaitsFamiliarityBrief(other)) continue;
    writeFact(other, servings.id, "itemLocation", { location: servings.location }, source);
  }
}

/**
 * `provisionsLow` (narrative) when this crate took the days the galley can still cook from what
 * is in the crates under `galley.lowBelowDays`. Counted at the serve, the one moment the crates go
 * down, so it is said once per fall (and again after a restock runs down).
 */
function noteProvisionsLow(ctx: StepCtx): void {
  const { lowBelowDays } = ctx.config.galley;
  const perDay = cratesPerDay(ctx.config);
  if (lowBelowDays <= 0 || perDay <= 0) return;
  const crates = provisionsCratesAboard(ctx.state, ctx.content);
  // A crate is a meal (`provisions.ts`), so the days are the crates over the crates a day.
  const daysOf = (n: number) => n / perDay;
  if (daysOf(crates + 1) < lowBelowDays || daysOf(crates) >= lowBelowDays) return;
  const days = provisionsDays(ctx.state, ctx.content, ctx.config);
  emitSim(ctx, "provisionsLow", [], { crates, days: Math.round(days * 100) / 100 });
}

/** The `serve` commit point (see the module comment). */
export function runServe(ctx: StepCtx, actor: Actor, _step: StepOf<"serve">): StepResult {
  const task = taskOf(ctx, actor);
  const problem = task === undefined ? undefined : openMealProblem(ctx, task);
  if (task === undefined || problem === undefined) return { fail: "dependencyPending" };
  const crate = provisionsInHand(ctx, actor);
  if (crate === undefined) return { fail: "inaccessibleSupply" };
  const meal = mealDef(ctx.content);
  if (meal === undefined) {
    throw new Error("runServe: content has no `meal`-tagged item def (L2 requires exactly one)");
  }
  const location = actor.location;
  if (location.kind !== "onDeck") return { fail: "unreachableTarget" };
  const stoveTile =
    (task.target.kind === "machine"
      ? positionTiles(ctx.state, ctx.content, task.target.machineId, "use")[0]
      : undefined) ?? tileAt(location);
  const config = ctx.config.galley;
  const quality = mealQuality(
    actor.skills.cooking ?? 0,
    roomTierAt(ctx.state, ctx.content, location.deckId, stoveTile),
    ctx.config,
  );
  const count = servingsPerMeal(ctx.state, ctx.config);
  useUp(ctx, crate);
  const id = allocateId(ctx.state, "item");
  const here = tileAt(location);
  const servings: StackItem = {
    id,
    defId: meal.id,
    stacking: "stack",
    count,
    reserved: 0,
    location: { kind: "onDeck", deckId: location.deckId, x: here.x + 0.5, y: here.y + 0.5 },
    meal: {
      quality,
      spoilsAtTick: ctx.tick + dayTicks(ctx.config, config.mealSpoilDays),
      cookId: actor.id,
    },
  };
  ctx.state.items[id] = servings;
  touchInventory(ctx);
  callTheMess(ctx, actor, servings);
  problem.status = "resolved";
  emitSim(ctx, "problemResolved", [problem.id], { problemId: problem.id, kind: problem.kind });
  emitSim(ctx, "mealServed", [actor.id, id], {
    cookId: actor.id,
    servings: unitsOf(servings),
    quality,
  });
  deposit(ctx, location.deckId, here, ctx.config.dirt.deposits.serving);
  noteProvisionsLow(ctx);
  return "done";
}
