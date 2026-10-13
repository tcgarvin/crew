/**
 * Labels for treatment (§treatment-at-the-medbay-bed), read by `systems/work/labels.ts`: "fetching
 * a med kit", "treating Priya Kessler" at the bed; the walks are the work system's ("walking to
 * the infirmary"), and the patient's "in the medbay" is its hold label.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActivityStep, Task } from "../../core/types/work";
import { type LabelCtx, itemName } from "../work/labels";

/** The treatment's own label for this step, or undefined where the generic one serves. */
export function treatLabel(
  ctx: LabelCtx,
  _actor: DeepReadonly<Actor>,
  task: DeepReadonly<Task>,
  step: DeepReadonly<ActivityStep>,
): string | undefined {
  if (step.kind === "pickUp") return `fetching a ${itemName(ctx, step.itemId)}`;
  if (step.kind !== "work" || task.target.kind !== "actor") return undefined;
  const patient = ctx.state.actors[task.target.actorId]?.name;
  return patient === undefined ? "treating the wounded" : `treating ${patient}`;
}
