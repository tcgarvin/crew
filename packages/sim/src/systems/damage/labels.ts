/**
 * Labels for damage work (D93, D94), read by `systems/work/labels.ts`: "patching the hull in the
 * hold", "plating the hull in the hold", "fetching a patch kit", "repairing impact damage to the
 * galley stove", "checking the hold".
 *
 * Gate stub: a plain verb per task type.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActivityStep, Task } from "../../core/types/work";
import type { LabelCtx } from "../work/labels";

const TASK_VERBS: Readonly<Record<string, string>> = {
  repairDamage: "repairing impact damage",
  patchHull: "patching the hull",
  plateHull: "plating the hull",
  checkCompartment: "checking for damage",
};

export function damageTaskLabel(
  _ctx: LabelCtx,
  _actor: DeepReadonly<Actor>,
  task: DeepReadonly<Task>,
  _step: DeepReadonly<ActivityStep>,
): string {
  return TASK_VERBS[task.type] ?? "working";
}
