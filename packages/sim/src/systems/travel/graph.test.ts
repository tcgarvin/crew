/**
 * Shortest path over the port graph (passengers-and-galaxy §2.3): by route distance, not hop
 * count; deterministic on ties; undefined for unknown or unreachable ports.
 */
import { describe, expect, it } from "vitest";
import type { PortDef } from "../../core/types/content";
import type { PortDefId } from "../../core/types/ids";
import { PORTS, fixtureContent } from "./fixtures";
import { hopCount, nextHop, shortestPath } from "./graph";

const ports = fixtureContent().ports;

function port(id: string, routes: readonly [string, number][]): PortDef {
  return {
    id: id as PortDefId,
    name: id,
    description: "",
    character: "",
    castSeed: [],
    externalStores: [],
    market: [],
    jobTemplates: [],
    routes: routes.map(([toPortId, distance]) => ({ toPortId: toPortId as PortDefId, distance })),
  };
}

describe("shortestPath", () => {
  it("returns the direct route between neighbours", () => {
    expect(shortestPath(ports, PORTS.a, PORTS.b)).toEqual({
      path: [PORTS.a, PORTS.b],
      distance: 25,
    });
  });

  it("finds the two-hop path to the spur port and sums its legs", () => {
    expect(shortestPath(ports, PORTS.a, PORTS.d)).toEqual({
      path: [PORTS.a, PORTS.c, PORTS.d],
      distance: 95,
    });
    expect(shortestPath(ports, PORTS.d, PORTS.a)?.path).toEqual([PORTS.d, PORTS.c, PORTS.a]);
  });

  it("prefers the shorter distance over fewer hops", () => {
    const graph = {
      x: port("x", [
        ["y", 10],
        ["z", 50],
      ]),
      y: port("y", [
        ["x", 10],
        ["z", 10],
      ]),
      z: port("z", [
        ["x", 50],
        ["y", 10],
      ]),
    };
    expect(shortestPath(graph, "x" as PortDefId, "z" as PortDefId)).toEqual({
      path: ["x", "y", "z"],
      distance: 20,
    });
  });

  it("is a one-port path of distance 0 from a port to itself", () => {
    expect(shortestPath(ports, PORTS.a, PORTS.a)).toEqual({ path: [PORTS.a], distance: 0 });
  });

  it("is undefined for an unknown port or one no route reaches", () => {
    expect(shortestPath(ports, PORTS.a, "port.nope" as PortDefId)).toBeUndefined();
    expect(shortestPath(ports, "port.nope" as PortDefId, PORTS.a)).toBeUndefined();
    const island = { ...ports, lone: port("lone", []) };
    expect(shortestPath(island, PORTS.a, "lone" as PortDefId)).toBeUndefined();
    // Reachability is directed: a route listed only from the island does not lead into it.
    const oneWay = { ...ports, lone: port("lone", [[PORTS.a, 5]]) };
    expect(shortestPath(oneWay, PORTS.a, "lone" as PortDefId)).toBeUndefined();
    expect(shortestPath(oneWay, "lone" as PortDefId, PORTS.a)?.distance).toBe(5);
  });

  it("ignores routes to ports the bundle does not define", () => {
    const dangling = { ...ports, [PORTS.a]: port(PORTS.a, [["port.ghost", 1]]) };
    expect(shortestPath(dangling, PORTS.a, PORTS.b)).toBeUndefined();
  });

  it("breaks equal-distance ties by port key order, so the result is stable", () => {
    const graph = {
      s: port("s", [
        ["m1", 10],
        ["m2", 10],
      ]),
      m1: port("m1", [["t", 10]]),
      m2: port("m2", [["t", 10]]),
      t: port("t", []),
    };
    const first = shortestPath(graph, "s" as PortDefId, "t" as PortDefId);
    expect(first).toEqual({ path: ["s", "m1", "t"], distance: 20 });
    expect(shortestPath(graph, "s" as PortDefId, "t" as PortDefId)).toEqual(first);
  });
});

describe("hopCount and nextHop", () => {
  it("counts legs, not ports", () => {
    expect(hopCount([PORTS.a, PORTS.c, PORTS.d])).toBe(2);
    expect(hopCount([PORTS.a])).toBe(0);
    expect(hopCount([])).toBe(0);
  });

  it("names the port after the origin on the shortest path", () => {
    expect(nextHop(ports, PORTS.a, PORTS.d)).toBe(PORTS.c);
    expect(nextHop(ports, PORTS.c, PORTS.d)).toBe(PORTS.d);
    expect(nextHop(ports, PORTS.a, PORTS.a)).toBeUndefined();
    expect(nextHop(ports, PORTS.a, "port.nope" as PortDefId)).toBeUndefined();
  });
});
