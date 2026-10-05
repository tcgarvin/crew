/**
 * Task derivation for the problem kinds the galley owns (D81), merged by `systems/work/` with the
 * other systems' rules:
 *
 * - `mealToCook` → one `cookMeal` task at the stove's `use` tile, `requiredSkills: [{ cooking,
 *   min: 1 }]`, `estimatedWorkSeconds: galley.cookSeconds`, progress `{ kind: "meal" }`. The plan
 *   is `cook.ts`'s own (one crate split off a stack, not the generic supply steps); the
 *   provisions defs are listed as its consumables only so that a cook who gives the meal up sets
 *   the crate in hand down where they stand and says so (`execute.ts` `dropTaskSupplies`), rather
 *   than walking off to bed with it.
 * - `mealToCarry` → one `carryMeal` task at the helm's standby tile, no skills, no work; done when
 *   the plate is set down (`stepsDone`): the galley settles the problem once a serving is within
 *   reach of the seat.
 *
 * Function declarations, not `const`s: `systems/work/` reads this table at module load and the
 * galley's modules import work's back.
 *
 * Owner: W1 of ship life slice 3.
 */
import type { ItemCount } from "../../core/types/content";
import type {
  DerivationCtx,
  ProblemOfKind,
  TaskDerivationTable,
  TaskSpec,
} from "../../core/types/work";
import { positionTiles, stoveOf } from "./kitchen";
import { provisionsDefs } from "./provisions";

function provisionsConsumables(ctx: DerivationCtx): ItemCount[] {
  return provisionsDefs(ctx.content).map((def) => ({ itemDefId: def.id, count: 1 }));
}

export function deriveMealToCook(
  problem: ProblemOfKind<"mealToCook">,
  ctx: DerivationCtx,
): TaskSpec[] {
  const stove = stoveOf(ctx.state, ctx.content);
  if (stove === undefined) return [];
  const { watchIndex } = problem.payload;
  return [
    {
      derivationKey: "cook",
      type: "cookMeal",
      target: { kind: "machine", machineId: stove.id },
      baseUrgency: "routineObligation",
      requiredSkills: [{ skill: "cooking", min: 1 }],
      requiredTools: [],
      consumables: provisionsConsumables(ctx),
      workerSlots: 1,
      interactionTiles: positionTiles(ctx.state, ctx.content, stove.id, "use"),
      dependencyIds: [],
      progressRef: { kind: "meal", watchIndex },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: ctx.config.galley.cookSeconds,
    },
  ];
}

export function deriveMealToCarry(
  problem: ProblemOfKind<"mealToCarry">,
  ctx: DerivationCtx,
): TaskSpec[] {
  const { machineId } = problem.payload;
  const standby = positionTiles(ctx.state, ctx.content, machineId, "use");
  if (standby.length === 0) return [];
  return [
    {
      derivationKey: "carry",
      type: "carryMeal",
      target: { kind: "machine", machineId },
      baseUrgency: "routineObligation",
      requiredSkills: [],
      requiredTools: [],
      consumables: [],
      workerSlots: 1,
      interactionTiles: standby,
      dependencyIds: [],
      progressRef: { kind: "occupancy", machineId },
      completion: { kind: "stepsDone" },
      estimatedWorkSeconds: 0,
    },
  ];
}

export const galleyTaskDerivations: Pick<TaskDerivationTable, "mealToCook" | "mealToCarry"> = {
  mealToCook: deriveMealToCook,
  mealToCarry: deriveMealToCarry,
};
