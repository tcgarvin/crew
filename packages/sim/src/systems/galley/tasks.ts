/**
 * Task derivation for the problem kinds the galley owns (D81): `mealToCook` → one `cookMeal` task
 * at the stove's `use` tile (`requiredSkills: [{ cooking, min: 1 }]`, no consumables: the plan
 * is `cook.ts`'s own, `estimatedWorkSeconds: galley.cookSeconds`, progress `{ kind: "meal" }`);
 * `mealToCarry` → one `carryMeal` task at the helm's standby tile (no skills,
 * `estimatedWorkSeconds` 0). Merged by `systems/work/` with the other systems' rules.
 *
 * Gate stubs: both derive nothing.
 *
 * Owner: W1 of ship life slice 3.
 */
import type { DeriveTasks } from "../../core/types/work";

const deriveMealToCook: DeriveTasks<"mealToCook"> = () => [];

const deriveMealToCarry: DeriveTasks<"mealToCarry"> = () => [];

export const galleyTaskDerivations = {
  mealToCook: deriveMealToCook,
  mealToCarry: deriveMealToCarry,
};
