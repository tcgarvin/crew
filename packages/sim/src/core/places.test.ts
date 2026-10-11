/**
 * Expeditions A2 (§3.2, plan calls 1 and 2): which sites are known, and the one graph every route
 * lookup and price check reads. The test site (`SITE.port`) lies near `TINY.port`, 10 away; the
 * tiny ports run dock —30— far —40— beyond.
 */
import { describe, expect, it } from "vitest";
import { SITE, siteContent } from "../systems/expedition/fixtures/site";
import { shortestPath } from "../systems/travel/graph";
import { TINY } from "./fixtures/tiny-content";
import { isSite, knownSites, portGraph, siteNearPort } from "./places";
import type { JobId } from "./types/ids";
import type { Job, JobStatus, TravelState } from "./types/travel";

const content = siteContent();
const JOB = "j.errand" as JobId;

function job(status: JobStatus, errand: boolean): Job {
  return {
    id: JOB,
    origin: "scenario",
    issuer: "Ysolde Maren, grower",
    issuerPerson: { name: "Ysolde Maren", role: "grower" },
    pitch: { key: "job.pitch", params: {} },
    urgency: "relaxed",
    description: { key: "job.template", params: {} },
    fromPortId: TINY.port2,
    toPortId: errand ? TINY.port2 : TINY.port,
    cargo: errand ? [] : [{ itemDefId: TINY.crate, count: 1 }],
    cargoClass: "general",
    pay: 300,
    status,
    offeredTick: 0,
    expiresAtTick: 10_000,
    cargoItemIds: [],
    ...(errand
      ? {
          errand: {
            kind: "fetchPerson",
            siteId: SITE.port,
            targetName: "Corran Vale",
            wants: "alive",
            returnToPortId: TINY.port2,
          },
        }
      : {}),
  };
}

const docked = (portId = TINY.port2): Extract<TravelState, { stage: "docked" }> => ({
  stage: "docked",
  portId,
});

function state(jobs: readonly Job[], travel: TravelState = docked()) {
  return { jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), travel };
}

const siteRoute = (graph: ReturnType<typeof portGraph>) =>
  graph[TINY.port]?.routes.find((r) => r.toPortId === SITE.port);

describe("sites and the graph (expeditions A2, calls 1 and 2)", () => {
  it("knows a site's near port, and only a site has one", () => {
    expect(isSite(content, SITE.port)).toBe(true);
    expect(siteNearPort(content, SITE.port)).toBe(TINY.port);
    expect(siteNearPort(content, TINY.port)).toBeUndefined();
    expect(siteNearPort(content, "port.nowhere" as typeof SITE.port)).toBeUndefined();
  });

  it("knows no site with no errand, and the known graph is the content's own", () => {
    const world = state([]);
    expect(knownSites(content, world)).toEqual([]);
    expect(portGraph(content, world, "known")).toBe(content.ports);
    expect(shortestPath(portGraph(content, world, "known"), TINY.port2, SITE.port)).toBeUndefined();
  });

  it("puts every authored site on the 'all' graph, at the site's own distance, leaving content alone", () => {
    const graph = portGraph(content, state([]), "all");
    expect(siteRoute(graph)).toEqual({ toPortId: SITE.port, distance: 10 });
    expect(siteRoute(content.ports)).toBeUndefined();
    expect(shortestPath(graph, TINY.port2, SITE.port)).toEqual({
      path: [TINY.port2, TINY.port, SITE.port],
      distance: 40,
    });
  });

  it("knows a site while an errand names it offered, accepted or in transit, and drops it after", () => {
    for (const status of ["offered", "accepted", "inTransit"] as const) {
      const world = state([job(status, true)]);
      expect(knownSites(content, world)).toEqual([SITE.port]);
      expect(siteRoute(portGraph(content, world, "known"))).toEqual({
        toPortId: SITE.port,
        distance: 10,
      });
    }
    for (const status of ["declined", "expired", "failed", "paid"] as const) {
      expect(knownSites(content, state([job(status, true)]))).toEqual([]);
    }
  });

  it("knows the site the ship is set down at or heading for, and nothing else makes one known", () => {
    // Freight, and a course to a port, know no site.
    expect(knownSites(content, state([job("accepted", false)]))).toEqual([]);
    expect(
      knownSites(content, state([], { ...docked(), plannedDestinationId: TINY.port })),
    ).toEqual([]);
    // Set down at it, or bound for it (planned, a voyage, or the leg in flight).
    expect(knownSites(content, state([], docked(SITE.port)))).toEqual([SITE.port]);
    expect(knownSites(content, state([], { ...docked(), voyageDestinationId: SITE.port }))).toEqual(
      [SITE.port],
    );
    const inFlight: TravelState = {
      stage: "transit",
      fromPortId: TINY.port,
      toPortId: SITE.port,
      stageProgress: 0,
      routeProgress: 0,
      routeDistance: 10,
      drifting: false,
      stageStartedTick: 0,
    };
    expect(knownSites(content, state([], inFlight))).toEqual([SITE.port]);
  });
});
