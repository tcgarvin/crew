/**
 * D94: a report on the intercom. At the end of the `report` step every damage fact the reporter
 * holds goes to every crew member aboard as `report` evidence with its original `observedTick`
 * (the `tellCrew` pattern in `systems/work/execute.ts`), `alert.reports` is set for each
 * compartment the report covers, and `intercomReport` names the damage.
 *
 * Gate stub: `reportPlan` is blocked, so the runner is never entered; it throws if it is.
 *
 * Owner: W3 of ship life slice 5.
 */
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import type { StepResult } from "../work/steps";

export function runReport(
  _ctx: StepCtx,
  _actor: Actor,
  _step: Extract<ActivityStep, { kind: "work" }>,
): StepResult {
  throw new NotImplementedError("intercom: runReport");
}
