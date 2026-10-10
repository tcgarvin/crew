/**
 * Freight nobody aboard owns (§offered-freight): the crates of a job that is on offer, or of one
 * closed (declined, expired) whose crates are still on the dock while a dock hand comes to cart
 * them back in. No work exists for them, the ship cannot use them as parts, and the frame marks
 * them.
 */
import type { DeepReadonly } from "./types/common";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { Item } from "./types/ship";

export function isNobodysFreight(
  state: Pick<ReadonlyWorldState, "jobs">,
  item: Pick<DeepReadonly<Item>, "jobId">,
): boolean {
  if (item.jobId === undefined) return false;
  const status = state.jobs[item.jobId]?.status;
  return status === "offered" || status === "declined" || status === "expired";
}
