/**
 * The commerce system (PLAN §6 W6 items 3–5): one per-tick pass that
 *  1. moves accepted jobs to `inTransit` once the ship leaves dock, raises `cargoToUnload`
 *     problems on arrival at the destination, and pays a delivered job exactly once,
 *  2. expires stale offers and surfaces the cards of offers that waited for the dock (D42),
 *  3. raises the `jobBoard` hook when the captain is docked with nothing to do (see
 *     `travel/hooks.ts` `raiseJobBoardHookIfNeeded`).
 *
 * D40 (2026-10-01): the narrator is the only source of work. The deterministic job source that
 * used to live beside this system (posting template offers while docked) is gone; `jobBoard` is
 * the sim asking the narrator for an offer, and the null narrator answers it offline from the
 * port's `jobTemplates`. Nothing here ever creates a job on its own.
 *
 * Runs in the same phase as travel (`equipment`), after it (registration order), so a job
 * accepted/offered this tick and a `setCourse` applied this tick are both visible by the time
 * this runs.
 */
import type { StepCtx, System } from "../../core/types/pipeline";
import { raiseJobBoardHookIfNeeded } from "../travel/hooks";
import { expireStaleOffers, payJobIfDue, raiseUnloadProblems, surfaceDeferredOffers } from "./jobs";

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
  surfaceDeferredOffers(ctx);
}

export const commerceSystem: System = {
  name: "commerce.jobs",
  phase: "equipment",
  run(ctx) {
    sweepJobs(ctx);
    raiseJobBoardHookIfNeeded(ctx);
  },
};
