/**
 * Cooking and serving (D81): the `cookMeal` plan and its two commit steps.
 *
 * W1 fills these in: `cookPlan` (nearest known `provisions` stack → `pickUp` split → the stove's
 * `use` position → `work cook` for `galley.cookSeconds` scaled by `workRate` → `moveTo` the
 * `serving` zone's first tile → `serve`); `runCook` (counts the step's ticks at the stove, a
 * `cooking` deposit at the end); `runServe` (consume the carried crate, spawn `crewAboard +
 * spareServings` servings, never more than `servingsPerCrate`, with `Item.meal` from the cook's
 * skill and the galley's tier, report them to every crew member aboard, `mealServed`, a `serving`
 * deposit, resolve `mealToCook`). The generic `supplySteps` is not used: it carries whole stacks.
 *
 * Gate stubs: the plan is blocked (`inaccessibleSupply`) and the steps throw, so no `cookMeal`
 * task runs until W1 lands (none is derived either: `tasks.ts`).
 *
 * Owner: W1 of ship life slice 3.
 */
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep, Task } from "../../core/types/work";
import type { PlanResult } from "../work/plans";
import type { StepResult } from "../work/steps";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

/** The `cookMeal` plan (see the module comment). */
export function cookPlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return { ok: false, reason: "inaccessibleSupply" };
}

/** The `work cook` stage at the stove. */
export function runCook(_ctx: StepCtx, _actor: Actor, _step: StepOf<"work">): StepResult {
  throw new NotImplementedError("runCook (W1)");
}

/** The `serve` commit point. */
export function runServe(_ctx: StepCtx, _actor: Actor, _step: StepOf<"serve">): StepResult {
  throw new NotImplementedError("runServe (W1)");
}
