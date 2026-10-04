/**
 * The commerce system (PLAN §6 W6 items 3–5): one per-tick pass that
 *  1. moves accepted jobs to `inTransit` once the ship leaves dock, raises `cargoToUnload`
 *     problems on arrival at the destination, and pays a delivered job exactly once,
 *  2. expires stale offers,
 *  3. sends the captain ashore to look for work when docked with nothing to do, raising the
 *     `captainAshore` hook the tick they step onto the dock, and delivers held cards in person
 *     (D70, `captain-ashore.ts`; this replaced `jobBoard` and D42's wait for the dock),
 *  4. walks passengers off and on, times their stay ashore and raises the overdue card
 *     (passengers-and-galaxy §3, `passage.ts`); it runs before the job sweep so a passage that
 *     completes this tick is paid this tick,
 *  5. keeps the ship's stores (D80, `reserve.ts`): docked at a port that sells what is low, it
 *     raises `reserveLow` for the shortfall, which the crew buy as they buy a part.
 *
 * D40 (2026-10-01): the narrator is the only source of work. The deterministic job source that
 * used to live beside this system (posting template offers while docked) is gone; `captainAshore`
 * is the sim asking the narrator for an offer, and the null narrator answers it offline from the
 * port's `jobTemplates`. Nothing here ever creates a job on its own.
 *
 * Runs in the same phase as travel (`equipment`), after it (registration order), so a job
 * accepted/offered this tick and a `setCourse` applied this tick are both visible by the time
 * this runs.
 */
import type { StepCtx, System } from "../../core/types/pipeline";
import { sweepCaptainAshore } from "./captain-ashore";
import { syncDockFreight } from "./dock-hands";
import { expireStaleOffers, payJobIfDue, raiseUnloadProblems } from "./jobs";
import { sweepPassages } from "./passage";
import { sweepReserves } from "./reserve";

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
  // D63, D66: after payment, so the bay is what is paid on; dock hands then cart the delivered
  // crates in, and an offer's crates out or back.
  syncDockFreight(ctx);
}

export const commerceSystem: System = {
  name: "commerce.jobs",
  phase: "equipment",
  run(ctx) {
    sweepPassages(ctx);
    sweepJobs(ctx);
    sweepCaptainAshore(ctx);
    sweepReserves(ctx);
  },
};
