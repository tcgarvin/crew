/**
 * The port graph (passengers-and-galaxy §2.3). Pure functions over content only: the sim keeps
 * the travel state machine single-hop and plans a multi-hop voyage one leg at a time from
 * `shortestPath(here, voyageDestination)`.
 *
 * Distances are `PortDef.routes[].distance` (the same units transit integrates), so "shortest"
 * is by travel distance, not hop count. Routes are directed as listed; content lists them
 * symmetrically. Ties are broken by port key order in `ports`, so the result is deterministic
 * for a given content bundle.
 */
import type { PortDef } from "../../core/types/content";
import type { PortDefId } from "../../core/types/ids";

export interface ShortestPath {
  /** Every port from `from` to `to` inclusive; `[from]` alone when they are the same port. */
  readonly path: readonly PortDefId[];
  /** Sum of the leg distances along `path`. */
  readonly distance: number;
}

/**
 * Dijkstra over `ports` from `from` to `to`, or `undefined` when either port is unknown or no
 * chain of routes joins them. Small graphs only (six ports in content), so the frontier is a
 * linear scan rather than a heap.
 */
export function shortestPath(
  ports: Readonly<Record<string, PortDef>>,
  from: PortDefId,
  to: PortDefId,
): ShortestPath | undefined {
  if (ports[from] === undefined || ports[to] === undefined) return undefined;
  const order = Object.keys(ports) as PortDefId[];
  const distance = new Map<PortDefId, number>([[from, 0]]);
  const previous = new Map<PortDefId, PortDefId>();
  const settled = new Set<PortDefId>();

  for (;;) {
    let current: PortDefId | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const id of order) {
      const d = distance.get(id);
      if (d !== undefined && !settled.has(id) && d < best) {
        best = d;
        current = id;
      }
    }
    if (current === undefined) return undefined;
    if (current === to) break;
    settled.add(current);
    const port = ports[current];
    if (port === undefined) continue;
    for (const route of port.routes) {
      if (ports[route.toPortId] === undefined || settled.has(route.toPortId)) continue;
      const candidate = best + route.distance;
      const known = distance.get(route.toPortId);
      if (known === undefined || candidate < known) {
        distance.set(route.toPortId, candidate);
        previous.set(route.toPortId, current);
      }
    }
  }

  const path: PortDefId[] = [to];
  for (let step = previous.get(to); step !== undefined; step = previous.get(step)) {
    path.unshift(step);
  }
  return { path, distance: distance.get(to) ?? 0 };
}

/** Legs in a path: one fewer than its ports (0 for a path of one port or an empty one). */
export function hopCount(path: readonly PortDefId[]): number {
  return Math.max(0, path.length - 1);
}

/** The port after `from` on the shortest path to `to`; `undefined` if unreachable or already there. */
export function nextHop(
  ports: Readonly<Record<string, PortDef>>,
  from: PortDefId,
  to: PortDefId,
): PortDefId | undefined {
  return shortestPath(ports, from, to)?.path[1];
}
