/**
 * Eating (D81): the `eat` plan, the `consume` commit point, the mess call's hold on the gangway
 * stander, and the `carryMeal` plan.
 *
 * `eatPlan` and `runConsume` moved here verbatim from `systems/work/plans.ts` / `steps.ts` at the
 * slice-3 gate. W1 fills in: `eatPlan` prefers a `meal` item and takes a free mess seat (a `use`
 * position of a `messTable` machine against the reservation cache), else the mess floor as today;
 * `consumeServing` gives hunger by `nutrition`, the thought by `meal.quality` (or `ateRationPack`),
 * `ateInDirtyMess` / `ateInFilthyMess` by the eater's room tier (`state.dirt.tiers`), an `eating`
 * deposit, and `ateMeal` with `quality` and `ration`; `mealCallStandsFor` (a known `meal` item on
 * deck and hunger above `galley.mealCallHungerAbove`) ends the gangway hold for dinner;
 * `carryMealPlan` splits one serving off the counter and sets it down at the helm's standby tile.
 *
 * Owner: W1 of ship life slice 3.
 */
import { dayTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { ItemId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ActivityStep, Task } from "../../core/types/work";
import { emitSim } from "../work/events";
import { type PlanResult, acquireSteps, blocked, carriedItems, planOf } from "../work/plans";
import { type StepResult, touchInventory } from "../work/steps";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

/** Eat: get one unit (unless one is in hand), optionally carry it to `table`, eat, consume. */
export function eatPlan(
  ctx: StepCtx,
  actor: Actor,
  itemId: ItemId | undefined,
  table: TileCoord | undefined,
): PlanResult {
  const mealTicks = dayTicks(ctx.config, ctx.config.needs.mealDays);
  const meal: ActivityStep[] = [
    ...(table === undefined
      ? []
      : [{ kind: "moveTo", target: { x: table.x, y: table.y }, requested: false } as const]),
    { kind: "work", stage: "eat", ticksDone: 0, ticksNeeded: mealTicks },
  ];
  const inHand = carriedItems(ctx, actor.id).find((item) =>
    ctx.content.items[item.defId]?.tags.includes("food"),
  );
  if (inHand !== undefined) return planOf([...meal, { kind: "consume", itemId: inHand.id }]);
  if (itemId === undefined) return blocked("inaccessibleSupply");
  const acquire = acquireSteps(ctx, actor, itemId, true);
  if (typeof acquire === "string") return blocked(acquire);
  return planOf([...acquire, ...meal, { kind: "consume", itemId }]);
}

/**
 * One carried unit of `item` is eaten by `actor`: hunger falls by the item's `nutrition` (food
 * without one fully satisfies), the unit is gone, `ateMeal` says what it was. Shared by the eat
 * step and the helm meal (W1 adds the thoughts and the `eating` deposit here).
 */
export function consumeServing(ctx: StepCtx, actor: Actor, item: Item): void {
  const nutrition = ctx.content.items[item.defId]?.nutrition ?? 1;
  actor.needs.hunger = Math.max(0, actor.needs.hunger - nutrition);
  if (item.stacking === "stack" && item.count > 1) item.count -= 1;
  else delete ctx.state.items[item.id];
  touchInventory(ctx);
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

/**
 * Does the mess call stand for `actor` (a hot meal they know of on deck, and hunger above
 * `galley.mealCallHungerAbove`)? Ends the gangway hold (`systems/watch/helm.ts`) for dinner.
 * Gate stub: never.
 */
export function mealCallStandsFor(_ctx: StepCtx, _actor: Actor): boolean {
  return false;
}

/** The `carryMeal` plan (see the module comment). Gate stub: blocked. */
export function carryMealPlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return blocked("inaccessibleSupply");
}
