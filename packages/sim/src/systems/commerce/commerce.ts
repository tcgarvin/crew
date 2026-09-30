/**
 * The commerce system (PLAN §6 W6 items 3–5): one per-tick pass that
 *  1. runs the deterministic job source (one offer at a time while docked),
 *  2. raises the `jobBoard` hook if the source was free to offer but had nothing to offer,
 *  3. moves accepted jobs to `inTransit` once the ship leaves dock, raises `cargoToUnload`
 *     problems on arrival at the destination, and pays a delivered job exactly once,
 *  4. expires stale offers.
 *
 * Runs in the same phase as travel (`equipment`), after it (registration order), so a job
 * accepted/offered this tick and a `setCourse` applied this tick are both visible by the time
 * this runs.
 */
import type { StepCtx, System } from "../../core/types/pipeline";
import { raiseJobBoardHookIfNeeded } from "../travel/hooks";
import { runJobSource } from "./jobSource";
import { expireStaleOffers, payJobIfDue, raiseUnloadProblems } from "./jobs";

function sweepJobs(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  for (const job of Object.values(ctx.state.jobs)) {
    if (job.status === "accepted" && travel.stage !== "docked") {
      job.status = "inTransit";
    }
    if (job.status === "inTransit" && travel.stage === "docked" && travel.portId === job.toPortId) {
      raiseUnloadProblems(ctx, job);
    }
    if (job.status === "accepted" || job.status === "inTransit" || job.status === "delivered") {
      payJobIfDue(ctx, job);
    }
  }
  expireStaleOffers(ctx);
}

export const commerceSystem: System = {
  name: "commerce.jobs",
  phase: "equipment",
  run(ctx) {
    const outcome = runJobSource(ctx);
    sweepJobs(ctx);
    raiseJobBoardHookIfNeeded(ctx, outcome === "nothing");
  },
};
