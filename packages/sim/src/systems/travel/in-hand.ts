/**
 * One job at a time (D16, D50): what "the job in hand" means to the board, to `acceptContract`
 * and to `setCourse`. Pure readers of `state.jobs` and `state.travel`; they live in travel (not
 * commerce) because travel's hook and course code need them and commerce already depends on
 * travel.
 */
import type { DeepReadonly } from "../../core/types/common";
import type { PortDefId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import type { Job } from "../../core/types/travel";

type JobsAndTravel = Pick<ReadonlyWorldState, "jobs" | "travel">;
type ReadonlyJob = DeepReadonly<Job>;

function dockedAt(state: Pick<ReadonlyWorldState, "travel">, portId: PortDefId): boolean {
  return state.travel.stage === "docked" && state.travel.portId === portId;
}

/** Accepted and neither paid nor closed; a passage counts until its `endReason` is set. */
export function jobInHand(job: ReadonlyJob): boolean {
  if (job.status === "accepted") return true;
  if (job.passage === undefined || job.passage.endReason !== undefined) return false;
  return job.status === "inTransit" || job.status === "delivered";
}

/**
 * A passage still has somewhere to go: the port its passenger is bound for next (`toPortId` on
 * the way out, `fromPortId` once ashore or homeward), or `undefined` for a job that is not a
 * live passage, or one whose passenger is at their last port and only has to walk off.
 */
function passageBound(
  state: Pick<ReadonlyWorldState, "travel">,
  job: ReadonlyJob,
): PortDefId | undefined {
  const passage = job.passage;
  if (passage === undefined || passage.endReason !== undefined) return undefined;
  if (job.status !== "accepted" && job.status !== "inTransit" && job.status !== "delivered") {
    return undefined;
  }
  if (passage.leg === "out") {
    if (passage.roundTrip) return dockedAt(state, job.toPortId) ? job.fromPortId : job.toPortId;
    return dockedAt(state, job.toPortId) ? undefined : job.toPortId;
  }
  if (passage.leg === "ashore") return job.fromPortId;
  return dockedAt(state, job.fromPortId) ? undefined : job.fromPortId;
}

/**
 * The job that stops the captain taking another one (D16/D50): freight that has not left its
 * origin (`accepted`) or is still on the way (`inTransit` anywhere but its destination), or a
 * passage that still has a port to reach (`passageBound`). A job being finished at this port
 * (freight unloading, a passenger walking off) does not block, so an offer surfaced on approach
 * can be taken the moment the ship docks instead of deadlocking on a card the captain cannot
 * accept until the sim runs.
 */
export function jobBlockingAcceptance(state: JobsAndTravel): ReadonlyJob | undefined {
  return Object.values(state.jobs).find((job) => {
    if (job.status === "accepted") return true;
    if (job.passage !== undefined) return jobInHand(job) && passageBound(state, job) !== undefined;
    // Freight under way blocks until the ship is at its destination (D52); `jobInHand` counts
    // only passages once they leave, so it is not the test here.
    return job.status === "inTransit" && !dockedAt(state, job.toPortId);
  });
}

/** The live passage the ship is carrying out, with the port it is bound for next. */
export function livePassage(
  state: JobsAndTravel,
): { job: ReadonlyJob; bound: PortDefId } | undefined {
  for (const job of Object.values(state.jobs)) {
    const bound = passageBound(state, job);
    if (bound !== undefined) return { job, bound };
  }
  return undefined;
}
