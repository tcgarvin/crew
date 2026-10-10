/**
 * Commerce invariants for tests (SD §19.4 style). §offered-freight: an offer's freight exists only
 * while it is staged: on the staging area of its origin's dock, alongside in `docking` or `docked`
 * (`offerStagingDock`), and nowhere else; a declined or expired offer has none. Pure over state and
 * content.
 *
 * §dock-hand-errands: the carting takes a walk, so the rule holds up to a dock hand on the way: an
 * offer due on the staging area may have no crates while one is bringing them out (`stageOffer`),
 * and one that should have none may keep them on the dock while one is coming for them
 * (`withdrawOffer`).
 */
import { isInDockArea } from "../../core/docks";
import type { DockHandErrand } from "../../core/types/dockside";
import type { JobId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { errandFor } from "./dock-hands";
import { offerStagingDock } from "./jobs";

export function commerceViolations(world: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const { state, content } = world;
  const errand = (jobId: JobId, kind: DockHandErrand["kind"]) =>
    errandFor(world, jobId, kind) !== undefined;
  for (const job of Object.values(state.jobs)) {
    const fetching = errand(job.id, "withdrawOffer");
    if (job.status === "declined" || job.status === "expired") {
      if (job.cargoItemIds.length > 0 && !fetching) {
        out.push(`${job.status} job ${job.id} still has freight`);
      }
      continue;
    }
    if (job.status !== "offered") continue;
    const staged = offerStagingDock({ state, content }, job) !== undefined;
    if (!staged) {
      if (job.cargoItemIds.length > 0 && !fetching) {
        out.push(
          `offered job ${job.id} has freight while not staged (stage ${state.travel.stage})`,
        );
      }
      continue;
    }
    if (
      job.cargoItemIds.length === 0 &&
      job.cargo.some((line) => line.count > 0) &&
      !errand(job.id, "stageOffer")
    ) {
      out.push(`offered job ${job.id} is not staged on its origin's dock`);
    }
    for (const itemId of job.cargoItemIds) {
      const item = state.items[itemId];
      if (item === undefined) out.push(`offered job ${job.id} lists missing item ${itemId}`);
      else if (!isInDockArea(content, state, item.location, "freightStaging")) {
        out.push(`offered job ${job.id} has ${itemId} off the staging area`);
      }
    }
  }
  return out;
}
