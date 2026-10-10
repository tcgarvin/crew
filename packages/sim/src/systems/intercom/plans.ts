/**
 * §reporting-damage: the reporting reflex's plan: the chosen panel's `operate` position, then a
 * `report` work step of `intercom.reportSeconds`. Whether the panel works is found out on arrival
 * (`runReport`), not here: the reporter cannot know a far panel is dead until they see it.
 *
 * Owner: W3 of ship life slice 5.
 */
import { configTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { MachineId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Intent } from "../../core/types/work";
import { type PlanResult, blocked, interactionTarget, planOf } from "../work/plans";

/** Is `machineId` an intercom panel (a `comm`-tagged machine) aboard? */
export function isPanel(ctx: Pick<StepCtx, "state" | "content">, machineId: MachineId): boolean {
  const machine = ctx.state.machines[machineId];
  const def = machine === undefined ? undefined : ctx.content.machines[machine.defId];
  return def?.tags.includes("comm") ?? false;
}

export function reportPlan(
  ctx: StepCtx,
  actor: Actor,
  intent: Extract<Intent, { kind: "personal" }>,
): PlanResult {
  const panelId = intent.targetId as MachineId | undefined;
  if (panelId === undefined || !isPanel(ctx, panelId)) return blocked("unreachableTarget");
  const target = interactionTarget(ctx, actor, panelId, "operate");
  if (target === undefined) return blocked("unreachableTarget");
  return planOf([
    { kind: "moveTo", target, requested: false },
    {
      kind: "work",
      stage: "report",
      ticksDone: 0,
      ticksNeeded: configTicks(ctx.config, ctx.config.intercom.reportSeconds),
    },
  ]);
}
