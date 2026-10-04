/**
 * Rounds (D77): the officer of the watch's walk (engineering, the hold, the mess, the helm's
 * standby position) and an idle on-duty engineer's machine round, `watches.roundsStopSeconds`
 * of `rounds` work at each stop and a `rounds` backoff of `watches.roundsEveryDays` after.
 *
 * Owner: W2 of ship life slice 2. Gate B stub: nothing plans `rounds` yet, and a plan for one is
 * blocked.
 */
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { PlanResult } from "../work/plans";

export function roundsPlan(_ctx: StepCtx, _actor: Actor): PlanResult {
  return { ok: false, reason: "unreachableTarget" };
}
