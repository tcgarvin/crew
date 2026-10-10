/**
 * §reporting-damage: labels for the reporting reflex, read by `systems/work/labels.ts`: "going to
 * the intercom", "on the intercom".
 *
 * Owner: W3 of ship life slice 5.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActivityStep } from "../../core/types/work";
import type { LabelCtx } from "../work/labels";

export function reportLabel(
  _ctx: LabelCtx,
  _actor: DeepReadonly<Actor>,
  step: DeepReadonly<ActivityStep>,
): string {
  return step.kind === "moveTo" ? "going to the intercom" : "on the intercom";
}
