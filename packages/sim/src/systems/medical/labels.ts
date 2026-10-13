/**
 * Labels for treatment (§treatment-at-the-medbay-bed), read by `systems/work/labels.ts`: "fetching
 * a med kit", "treating Priya Kessler" at the bed; the walks are the work system's ("walking to
 * the infirmary"), and the patient's "in the medbay" is its hold label. A carry (§extraction):
 * "going to Priya Kessler", "picking up Priya Kessler", then "carrying Priya Kessler to the
 * medbay" while she is in the carrier's arms.
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

/** §extraction: the carrier's label for this step of a carry. */
export function carryLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  task: DeepReadonly<Task>,
  step: DeepReadonly<ActivityStep>,
): string {
  const target = task.target;
  const patient = target.kind === "actor" ? ctx.state.actors[target.actorId] : undefined;
  const name = patient?.name ?? "the wounded";
  if (step.kind === "work" && step.stage === "lift") return `picking up ${name}`;
  const held = patient?.location.kind === "carriedBy" && patient.location.actorId === actor.id;
  return held ? `carrying ${name} to the medbay` : `going to ${name}`;
}
