/**
 * Commerce invariants for tests (SD §19.4 style). D63: an offer's freight exists only while it is
 * staged: on the staging area of its origin's dock, alongside in `docking` or `docked`
 * (`offerStagingDock`), and nowhere else; a declined or expired offer has none. Pure over state
 * and content.
 */
import { isInDockArea } from "../../core/docks";
import type { World } from "../../core/types/kernel";
import { offerStagingDock } from "./jobs";

export function commerceViolations(world: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const { state, content } = world;
  for (const job of Object.values(state.jobs)) {
    if (job.status === "declined" || job.status === "expired") {
      if (job.cargoItemIds.length > 0) out.push(`${job.status} job ${job.id} still has freight`);
      continue;
    }
    if (job.status !== "offered") continue;
    const staged = offerStagingDock({ state, content }, job) !== undefined;
    if (!staged) {
      if (job.cargoItemIds.length > 0) {
        out.push(
          `offered job ${job.id} has freight while not staged (stage ${state.travel.stage})`,
        );
      }
      continue;
    }
    if (job.cargoItemIds.length === 0 && job.cargo.some((line) => line.count > 0)) {
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
