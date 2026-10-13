/**
 * Plans for medicine (§treatment-at-the-medbay-bed, §convalescing), built from what the actor
 * believes about where things are:
 *
 * - `treatPlan`: `medical.kitsPerTreatment` units in hand (already carried, or split off the
 *   nearest `medical` stack they know of: `inaccessibleSupply` with none) → the tile beside the
 *   bed nearest them → `treat` work for `treatSecondsPerWound` a wound to treat (`steps.ts`
 *   `runTreat`). With the patient not lying at the bed yet the plan is blocked
 *   `dependencyPending` (task-level: everyone backs off and tries again later).
 * - `convalescePlan`: the patient to the bed's `use` position and a `convalesce` hold there; a bed
 *   someone else lies at is `occupiedPosition`.
 */
import { configTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ActivityStep, BlockageReason, Task } from "../../core/types/work";
import { knownOnDeck, nearestReachable } from "../damage/plans";
import { type PlanResult, acquireSteps, blocked, carriedItems, planOf } from "../work/plans";
import { medBedOf, onTheBed } from "./bed";
import { untreatedWounds } from "./medical";

const isMedical = (ctx: StepCtx, item: Pick<Item, "defId">): boolean =>
  ctx.content.items[item.defId]?.tags.includes("medical") === true;

/** The `medical` units the actor carries (truth: they know what is in their hands). */
export function kitsInHand(ctx: StepCtx, actor: Actor): Item[] {
  return carriedItems(ctx, actor.id).filter((item) => isMedical(ctx, item));
}

/** Units in `items`: a stack counts its count. */
export const unitsOf = (items: readonly Item[]): number =>
  items.reduce((sum, item) => sum + (item.stacking === "stack" ? item.count : 1), 0);

/** Steps to have `kitsPerTreatment` units in hand, each split off the nearest known stack. */
function kitSteps(ctx: StepCtx, actor: Actor): ActivityStep[] | BlockageReason {
  const missing = ctx.config.medical.kitsPerTreatment - unitsOf(kitsInHand(ctx, actor));
  if (missing <= 0) return [];
  const [stockId] = knownOnDeck(ctx, actor, (item) => isMedical(ctx, item));
  if (stockId === undefined) return "inaccessibleSupply";
  const steps: ActivityStep[] = [];
  for (let i = 0; i < missing; i++) {
    const acquire = acquireSteps(ctx, actor, stockId, true);
    if (typeof acquire === "string") return acquire;
    steps.push(...acquire);
  }
  return steps;
}

export function treatPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "actor") return blocked("unreachableTarget");
  const patient = ctx.state.actors[task.target.actorId];
  const bed = medBedOf(ctx.state, ctx.content);
  if (patient === undefined || bed === undefined) return blocked("unreachableTarget");
  if (!onTheBed(ctx.state, bed, patient)) return blocked("dependencyPending");
  const kits = kitSteps(ctx, actor);
  if (typeof kits === "string") return blocked(kits);
  const stand = nearestReachable(ctx, actor, task.interactionTiles);
  if (stand === undefined) return blocked("unreachableTarget");
  const seconds = ctx.config.medical.treatSecondsPerWound * untreatedWounds(patient).length;
  return planOf([
    ...kits,
    { kind: "moveTo", target: { x: stand.x, y: stand.y }, requested: false },
    {
      kind: "work",
      stage: "treat",
      ticksDone: 0,
      ticksNeeded: Math.max(1, configTicks(ctx.config, seconds)),
    },
  ]);
}

export function convalescePlan(ctx: StepCtx, actor: Actor): PlanResult {
  const bed = medBedOf(ctx.state, ctx.content);
  if (bed === undefined) return blocked("unreachableTarget");
  const taken = Object.values(ctx.state.actors).some(
    (other) =>
      other.id !== actor.id && other.availability !== "dead" && onTheBed(ctx.state, bed, other),
  );
  if (taken) return blocked("occupiedPosition");
  return planOf([
    {
      kind: "moveTo",
      target: { machineId: bed.machineId, positionKey: bed.positionKey },
      requested: false,
    },
    { kind: "hold", hold: "convalesce", sinceTick: ctx.tick },
  ]);
}
