/**
 * Expeditions A1 (§3.1, plan call 4): ports and sites. A site is a `PortDef` of `kind: "site"`, a
 * landing that sells nothing, with one authored route to its near port and none back: no port
 * lists a site in its `routes` (L2).
 *
 * Expeditions A2 (§3.2, plan calls 1 and 2): a site is on the graph only while it is known. A
 * known site is one an errand names while the errand is `offered`, `accepted` or `inTransit`, or the
 * one the ship is set down at or heading for. `portGraph` is the one place the near port's route to
 * a site is added, so every route lookup (planning, the leg's distance, a voyage's next hop) and
 * every price check sees the same graph.
 */
import type { ContentBundle, PortDef } from "./types/content";
import type { PortDefId } from "./types/ids";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { JobStatus } from "./types/travel";

type Ports = Pick<ContentBundle, "ports">;
type JobsAndTravel = Pick<ReadonlyWorldState, "jobs" | "travel">;

/** Is `portId` a landing site rather than a port? False for an unknown id. */
export function isSite(content: Ports, portId: PortDefId): boolean {
  return content.ports[portId]?.kind === "site";
}

/** The port a site lies near (its one route), or `undefined` when `siteId` is not a site. */
export function siteNearPort(content: Ports, siteId: PortDefId): PortDefId | undefined {
  const site = content.ports[siteId];
  return site?.kind === "site" ? site.nearPortId : undefined;
}

/** Call 1: an errand keeps its site known from the offer until the job is over. */
const ERRAND_KEEPS_SITE: ReadonlySet<JobStatus> = new Set(["offered", "accepted", "inTransit"]);

/**
 * Call 1: every known site, in content order. An offer that expires or is declined drops its site
 * again; nothing can be under way to it then.
 */
export function knownSites(content: Ports, state: JobsAndTravel): PortDefId[] {
  const named = new Set<PortDefId>();
  for (const job of Object.values(state.jobs)) {
    if (job.errand !== undefined && ERRAND_KEEPS_SITE.has(job.status)) named.add(job.errand.siteId);
  }
  const travel = state.travel;
  const ship =
    travel.stage === "docked"
      ? [travel.portId, travel.plannedDestinationId, travel.voyageDestinationId]
      : [travel.toPortId, travel.voyageDestinationId];
  for (const portId of ship) if (portId !== undefined) named.add(portId);
  return (Object.keys(content.ports) as PortDefId[]).filter(
    (id) => named.has(id) && isSite(content, id),
  );
}

/**
 * Call 2: the ports with, on each site's near port, a route to the site of the site's own authored
 * distance back. `"known"` adds the known sites (what the ship may fly), `"all"` every authored site
 * (what a price is checked over, since a site is not known until its offer exists). The content's
 * own record when no site is added.
 */
export function portGraph(
  content: Ports,
  state: JobsAndTravel,
  mode: "known" | "all",
): Readonly<Record<string, PortDef>> {
  const sites =
    mode === "known"
      ? knownSites(content, state)
      : (Object.keys(content.ports) as PortDefId[]).filter((id) => isSite(content, id));
  if (sites.length === 0) return content.ports;
  const graph: Record<string, PortDef> = { ...content.ports };
  for (const siteId of sites) {
    const site = content.ports[siteId];
    const nearPortId = site?.nearPortId;
    const near = nearPortId === undefined ? undefined : graph[nearPortId];
    const back = site?.routes.find((r) => r.toPortId === nearPortId);
    // A site the schema let through without its one route (L2 refuses it) stays off the graph.
    if (near === undefined || back === undefined) continue;
    if (near.routes.some((r) => r.toPortId === siteId)) continue;
    graph[near.id] = {
      ...near,
      routes: [...near.routes, { toPortId: siteId, distance: back.distance }],
    };
  }
  return graph;
}
