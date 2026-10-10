/**
 * The floor set (Dockside §5.2, §floor-set-rule): who is on a port's dock without the narrator
 * putting them there. Pure over state and content, with no draw on the rng streams (names come from
 * a hash of the save's seed and the job), so the `stageDock` hook's context can show the narrator
 * exactly the people the sim will place when the dock comes alongside, and a reload computes the
 * same.
 *
 * 1. Regulars: every `castSeed` entry with a `post` on this dock, at that post.
 * 2. The job in hand: the receiver for freight bound here, a dock hand named from the content
 *    name table, by the warehouse door; they cart the crates in once they are delivered. (The
 *    issuer of a job finishing here is never at the destination: freight is issued at its
 *    origin, and a round trip's issuer is the passenger, aboard.)
 * 3. A passenger due back appears at the gate as an actor (§dock-market-and-passengers), so is not
 *    a local.
 * 4. A passenger left behind or put off here earlier (§ending-a-passage-early), on the bench if the
 *    dock has one.
 */
import { dockForPort, dockPost } from "./docks";
import { byId } from "./ids";
import { hashString32 } from "./rng";
import type { DeepReadonly } from "./types/common";
import type { ContentBundle, DockDef } from "./types/content";
import type { FloorSetEntry } from "./types/dockside";
import type { JobId, PortDefId } from "./types/ids";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { Job } from "./types/travel";

type FloorSetState = Pick<ReadonlyWorldState, "seed" | "jobs" | "actors">;

/** What a generic dock hand is called when content has no name table. */
export const DOCK_HAND_ROLE = "dock hand";
const UNNAMED_DOCK_HAND = "Dock hand";

/**
 * A dock hand's name, drawn from the content name table by a hash of `key` (a job id, or an
 * errand's local id) and the save's seed: stable for one job, varied across jobs.
 */
export function dockHandName(
  content: Pick<ContentBundle, "people">,
  seed: number,
  key: string,
): string {
  const people = content.people;
  if (people === undefined || people.givenNames.length === 0) return UNNAMED_DOCK_HAND;
  const hash = hashString32(`${seed}:${key}`);
  const given = people.givenNames[hash % people.givenNames.length] ?? UNNAMED_DOCK_HAND;
  if (people.familyNames.length === 0) return given;
  const familyIndex = Math.floor(hash / people.givenNames.length) % people.familyNames.length;
  const family = people.familyNames[familyIndex];
  return family === undefined || family === given ? given : `${given} ${family}`;
}

/**
 * Freight bound for `portId` and still to be delivered there (the job in hand, §one-job-in-hand).
 */
function freightBoundHere(job: DeepReadonly<Job>, portId: PortDefId): boolean {
  if (job.passage !== undefined || job.toPortId !== portId) return false;
  if (job.status !== "accepted" && job.status !== "inTransit") return false;
  return job.cargo.some((line) => line.count > 0);
}

function regulars(content: ContentBundle, dock: DockDef, portId: PortDefId): FloorSetEntry[] {
  const port = content.ports[portId];
  if (port === undefined) return [];
  const posts = new Set(dock.posts.map((p) => p.key));
  return port.castSeed.flatMap((seed) =>
    seed.post === undefined || !posts.has(seed.post)
      ? []
      : [{ name: seed.name, role: seed.role, postKey: seed.post, reason: { kind: "regular" } }],
  );
}

function receivers(
  state: FloorSetState,
  content: ContentBundle,
  dock: DockDef,
  portId: PortDefId,
): FloorSetEntry[] {
  const door = dockPost(dock, "warehouseDoor");
  if (door === undefined) return [];
  return Object.values(state.jobs)
    .filter((job) => freightBoundHere(job, portId))
    .sort(byId)
    .map((job) => ({
      name: dockHandName(content, state.seed, job.id),
      role: DOCK_HAND_ROLE,
      postKey: door.key,
      reason: { kind: "receiver", jobId: job.id as JobId },
      label: "waiting for a delivery",
    }));
}

/**
 * §ending-a-passage-early: a passenger whose passage ended at this port and who is still here, off
 * ship.
 */
function benchPassenger(state: FloorSetState, dock: DockDef, portId: PortDefId): FloorSetEntry[] {
  const bench = dockPost(dock, "bench");
  if (bench === undefined) return [];
  const ended = new Set(
    Object.values(state.jobs).flatMap((job) =>
      job.passage?.endReason === "leftBehind" || job.passage?.endReason === "putOff"
        ? [job.passage.actorId]
        : [],
    ),
  );
  const here = Object.values(state.actors)
    .filter((actor) => {
      const location = actor.location;
      return (
        actor.passenger === true &&
        actor.availability === "offShip" &&
        ended.has(actor.id) &&
        location.kind === "inExternalStore" &&
        location.portId === portId
      );
    })
    .sort(byId);
  const [first] = here;
  if (first === undefined) return [];
  return [
    {
      name: first.name,
      role: "passenger",
      postKey: bench.key,
      reason: { kind: "passenger", actorId: first.id },
      label: "sitting on the bench",
    },
  ];
}

/**
 * Everyone the sim puts on `portId`'s dock by itself, in placement order, one entry per name
 * (case-insensitive; the first wins). Empty for a port without a dock map.
 */
export function floorSet(
  state: FloorSetState,
  content: ContentBundle,
  portId: PortDefId,
): FloorSetEntry[] {
  const dock = dockForPort(content, portId);
  if (dock === undefined) return [];
  const seen = new Set<string>();
  const out: FloorSetEntry[] = [];
  for (const entry of [
    ...regulars(content, dock, portId),
    ...receivers(state, content, dock, portId),
    ...benchPassenger(state, dock, portId),
  ]) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
