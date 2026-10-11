/**
 * Expeditions A2 (§6, plan calls 5 and 11): the errand's ending. `settleErrand` is the only writer
 * of `Job.errand.outcome`; commerce asks `errandFulfilled` whether an errand without a passage has
 * earned its pay (`jobFulfilled`).
 *
 * Owner after the gate: W1 of expeditions A2. Gate stubs: `settleErrand` settles nothing and
 * `errandFulfilled` is never true, so an errand is never paid until W1.
 */
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { ExpeditionOutcome } from "../../core/types/state";
import type { Job } from "../../core/types/travel";
import type { Fight } from "./combat";

/**
 * Call 5: settle the errand of the expedition that just resolved with `outcome` (the job by
 * `expedition.jobId`; none, nothing to settle). Called by `resolve()` after `afterTheFight` and
 * before the party and the cast leave the fight. Gate stub: no-op.
 */
export function settleErrand(_fight: Fight, _outcome: ExpeditionOutcome): void {}

/**
 * Has an errand without a passage earned its pay? (A target brought alive is a passage, paid by the
 * passage rule.) Gate stub: never.
 */
export function errandFulfilled(
  _state: Pick<ReadonlyWorldState, "items" | "deck" | "travel">,
  _content: Pick<StepCtx["content"], "docks" | "decks">,
  _job: Pick<Job, "cargoItemIds" | "toPortId" | "errand">,
): boolean {
  return false;
}
