/**
 * D94: the reporting reflex's plan: the nearest working panel's `operate` position, then a
 * `report` work step of `intercom.reportSeconds`.
 *
 * Gate stub: blocked.
 *
 * Owner: W3 of ship life slice 5.
 */
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { Intent } from "../../core/types/work";
import { type PlanResult, blocked } from "../work/plans";

export function reportPlan(
  _ctx: StepCtx,
  _actor: Actor,
  _intent: Extract<Intent, { kind: "personal" }>,
): PlanResult {
  return blocked("unreachableTarget");
}
