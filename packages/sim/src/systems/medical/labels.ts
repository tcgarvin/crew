/**
 * Labels for treatment (§treatment-at-the-medbay-bed), read by `systems/work/labels.ts`: "fetching
 * a med kit", "treating Priya Kessler" at the bed; the walks are the work system's ("walking to
 * the infirmary"), and the patient's "in the medbay" is its hold label. A carry (§extraction):
 * "going to Priya Kessler", "picking up Priya Kessler", then "carrying Priya Kessler to the
 * medbay" while she is in the carrier's arms. A body (§the-body-aboard): "going to Tomas Ruiz",
 * "lifting Tomas Ruiz's body", then "carrying Tomas Ruiz's body to the cargo hold".
 */
import { roomPhrase } from "../../core/rooms";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActivityStep, Task } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { symbolAt } from "../damage/deck";
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
  const held = patient?.location.kind === "carriedBy" && patient.location.actorId === actor.id;
  const lifting = step.kind === "work" && step.stage === "lift";
  if (task.type === "carryBody") {
    const body = patient === undefined ? "the body" : `${patient.name}'s body`;
    if (lifting) return `lifting ${body}`;
    if (held) return `carrying ${body} to ${restingRoom(ctx, task)}`;
    return `going to ${patient?.name ?? "the body"}`;
  }
  const name = patient?.name ?? "the wounded";
  if (lifting) return `picking up ${name}`;
  return held ? `carrying ${name} to the medbay` : `going to ${name}`;
}

/** §the-body-aboard: the room a body's resting place is in ("the cargo hold"). */
function restingRoom(ctx: LabelCtx, task: DeepReadonly<Task>): string {
  const problem = ctx.state.work.problems[task.problemId];
  const deck = ctx.content.decks[shipDeckId(ctx.state)];
  if (problem?.kind !== "bodyAboard" || deck === undefined) return "its resting place";
  const symbol = symbolAt(deck, problem.payload.tile);
  const def = deck.compartments.find((c) => c.symbol === symbol);
  return def === undefined ? "its resting place" : roomPhrase(def);
}
