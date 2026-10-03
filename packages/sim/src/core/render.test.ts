/**
 * Polish A: the render frame's items-aboard projection (D28) and ship headline (D27).
 */
import { describe, expect, it } from "vitest";
import { tinyTestWorld } from "./fixtures/test-world";
import { TINY } from "./fixtures/tiny-content";
import { doorOpenFraction, formatEta, renderItems, renderTravel, shipHeadline } from "./render";
import type { ItemId, JobId, ProblemId } from "./types/ids";
import type { WorldState } from "./types/state";
import type { Job, JobPassage } from "./types/travel";
import type { Problem } from "./types/work";

const JOB = "j1" as JobId;
const CRATES = ["i.c1", "i.c2", "i.c3"] as ItemId[];
const STORE = { kind: "inExternalStore", portId: TINY.port, storeKey: "warehouse" } as const;

function job(status: Job["status"]): Job {
  return {
    id: JOB,
    origin: "portBoard",
    issuer: "Ines Oduya, Tiny Freight",
    issuerPerson: { name: "Ines Oduya", role: "dock foreman", org: "Tiny Freight" },
    pitch: { key: "job.pitch", params: {} },
    urgency: "soon",
    description: { key: "job.template", params: {} },
    fromPortId: TINY.port,
    toPortId: TINY.port2,
    cargo: [{ itemDefId: TINY.crate, count: 3 }],
    cargoClass: "general",
    pay: 300,
    status,
    offeredTick: 0,
    expiresAtTick: 10_000,
    cargoItemIds: status === "offered" ? [] : [...CRATES],
  };
}

/** Three crates of `JOB`, each with a cargo problem of `kind`, placed per `where`. */
function addFreight(
  state: WorldState,
  kind: "cargoToLoad" | "cargoToUnload",
  where: readonly ("store" | "deck" | "carried" | "ashore")[],
): void {
  where.forEach((place, i) => {
    const id = CRATES[i] as ItemId;
    const location =
      place === "deck"
        ? { kind: "onDeck" as const, deckId: TINY.deck, x: 3, y: 1 }
        : place === "carried"
          ? { kind: "carriedBy" as const, actorId: "a1" as never }
          : place === "ashore"
            ? { ...STORE, portId: TINY.port2 }
            : STORE;
    state.items[id] = {
      id,
      defId: TINY.crate,
      stacking: "unique",
      condition: 1,
      location,
      jobId: JOB,
    };
    const done = kind === "cargoToLoad" ? place === "deck" : place === "ashore";
    const problemId = `p.${kind}.${i}` as ProblemId;
    state.work.problems[problemId] = {
      id: problemId,
      kind,
      payload:
        kind === "cargoToLoad"
          ? { jobId: JOB, itemId: id, stowageZoneKey: "hold" }
          : { jobId: JOB, itemId: id, portId: TINY.port2, storeKey: "warehouse" },
      owner: "commerce",
      visibility: "public",
      dedupeKey: `${kind}:${JOB}:${id}`,
      status: done ? "resolved" : "open",
      createdTick: 0,
      revision: 0,
      baseUrgency: "routineObligation",
      location: { kind: "port", portId: TINY.port },
    } as Problem;
  });
}

function underway(
  state: WorldState,
  stage: Exclude<WorldState["travel"]["stage"], "docked">,
  routeProgress = 0,
): void {
  state.travel = {
    stage,
    fromPortId: TINY.port,
    toPortId: TINY.port2,
    stageProgress: 0,
    routeProgress,
    routeDistance: 30,
    drifting: false,
    stageStartedTick: 0,
  };
}

function headline(state: WorldState, content = tinyTestWorld().world.content): string {
  return shipHeadline(state, content, 1);
}

describe("shipHeadline", () => {
  it("says the ship is looking for work when docked with nothing on", () => {
    const { world } = tinyTestWorld();
    expect(headline(world.state)).toBe("Docked at Tiny Dock — looking for work");
  });

  it("waits for a passenger ashore by name, ahead of the planned course home", () => {
    const { world } = tinyTestWorld();
    const passage: JobPassage = { actorId: "a1" as never, roundTrip: true, leg: "ashore" };
    world.state.jobs[JOB] = {
      ...job("accepted"),
      status: "inTransit",
      fromPortId: TINY.port2,
      toPortId: TINY.port,
      cargo: [],
      cargoItemIds: [],
      passage,
    };
    world.state.travel = { stage: "docked", portId: TINY.port, plannedDestinationId: TINY.port2 };
    expect(headline(world.state)).toBe("Waiting for Mara Voss — docked at tiny dock");
    // Ended passages (left behind) no longer hold the headline.
    passage.endReason = "leftBehind";
    expect(headline(world.state)).toBe("Preparing to depart for Far Dock");
  });

  it("does not narrate an open offer in the headline", () => {
    const { world } = tinyTestWorld();
    world.state.jobs[JOB] = job("offered");
    expect(headline(world.state)).toBe("Docked at Tiny Dock — looking for work");
  });

  it("counts crates stowed aboard while loading", () => {
    const { world } = tinyTestWorld();
    world.state.jobs[JOB] = job("accepted");
    addFreight(world.state, "cargoToLoad", ["deck", "deck", "carried"]);
    expect(headline(world.state)).toBe(
      "Docked at Tiny Dock — loading cargo (2 of 3 crates aboard)",
    );
  });

  it("counts a stacked crate line in units, not items", () => {
    const { world } = tinyTestWorld();
    world.state.jobs[JOB] = job("accepted");
    addFreight(world.state, "cargoToLoad", ["deck", "store"]);
    world.state.items[CRATES[0] as ItemId] = {
      id: CRATES[0] as ItemId,
      defId: TINY.crate,
      stacking: "stack",
      count: 2,
      reserved: 0,
      location: { kind: "onDeck", deckId: TINY.deck, x: 3.5, y: 1.5 },
      jobId: JOB,
    };
    world.state.jobs[JOB] = { ...job("accepted"), cargoItemIds: CRATES.slice(0, 2) };
    expect(headline(world.state)).toBe(
      "Docked at Tiny Dock — loading cargo (2 of 3 crates aboard)",
    );
  });

  it("reports preparing to depart once a course is set and the hold is full", () => {
    const { world } = tinyTestWorld();
    world.state.travel = { stage: "docked", portId: TINY.port, plannedDestinationId: TINY.port2 };
    expect(headline(world.state)).toBe("Preparing to depart for Far Dock");
    underway(world.state, "preparingDeparture");
    expect(headline(world.state)).toBe("Preparing to depart for Far Dock");
  });

  it("names the stage for undocking, approach and docking", () => {
    const { world } = tinyTestWorld();
    underway(world.state, "undocking");
    expect(headline(world.state)).toBe("Undocking from Tiny Dock — bound for Far Dock");
    underway(world.state, "approaching");
    expect(headline(world.state)).toBe("Approaching Far Dock");
    underway(world.state, "docking");
    expect(headline(world.state)).toBe("Docking at Far Dock");
  });

  it("gives an ETA in transit, and says so when adrift", () => {
    const { world } = tinyTestWorld();
    underway(world.state, "transit", 12);
    // 18 distance left at nominal speed 1 and no engines in the tiny deck (factor 1).
    expect(headline(world.state)).toBe("Under way to Far Dock — 18 s");
    if (world.state.travel.stage === "transit") world.state.travel.drifting = true;
    expect(headline(world.state)).toBe("Adrift on the way to Far Dock — engines down");
  });

  it("names the voyage destination under way and at a waypoint (§2.3), not on a direct leg", () => {
    const { world } = tinyTestWorld();
    underway(world.state, "transit", 12);
    world.state.travel.voyageDestinationId = TINY.port3;
    expect(headline(world.state)).toBe("Under way to Far Dock, bound for Beyond Dock — 18 s");
    world.state.travel = { stage: "docked", portId: TINY.port2, voyageDestinationId: TINY.port3 };
    expect(headline(world.state)).toBe("Stopping at Far Dock on the way to Beyond Dock");
    world.state.travel.plannedDestinationId = TINY.port3;
    expect(headline(world.state)).toBe("Stopping at Far Dock on the way to Beyond Dock");
    world.state.travel.holdForRepairs = true;
    expect(headline(world.state)).toBe(
      "Stopping at Far Dock on the way to Beyond Dock — holding for repairs",
    );
    // The last leg of a voyage reads like a direct one.
    underway(world.state, "transit", 12);
    world.state.travel.voyageDestinationId = TINY.port2;
    expect(headline(world.state)).toBe("Under way to Far Dock — 18 s");
  });

  it("counts crates carried ashore while unloading", () => {
    const { world } = tinyTestWorld();
    world.state.travel = { stage: "docked", portId: TINY.port2 };
    world.state.jobs[JOB] = { ...job("inTransit"), fromPortId: TINY.port };
    addFreight(world.state, "cargoToUnload", ["ashore", "carried", "deck"]);
    expect(headline(world.state)).toBe(
      "Docked at Far Dock — unloading cargo (1 of 3 crates ashore)",
    );
  });
});

describe("renderTravel", () => {
  it("names the dock's port as both ends while docked, never drifting", () => {
    expect(
      renderTravel({ stage: "docked", portId: TINY.port2, plannedDestinationId: TINY.port3 }),
    ).toEqual({
      state: "docked",
      progress: 0,
      fromPortId: TINY.port2,
      toPortId: TINY.port2,
      drifting: false,
    });
  });

  it("carries both ports, stage progress and drifting under way", () => {
    const { world } = tinyTestWorld();
    underway(world.state, "docking");
    if (world.state.travel.stage === "docked") throw new Error("expected under way");
    world.state.travel.stageProgress = 0.4;
    world.state.travel.drifting = true;
    expect(renderTravel(world.state.travel)).toEqual({
      state: "docking",
      progress: 0.4,
      fromPortId: TINY.port,
      toPortId: TINY.port2,
      drifting: true,
    });
  });

  it("reports route progress as the fraction in transit", () => {
    const { world } = tinyTestWorld();
    underway(world.state, "transit", 12);
    expect(renderTravel(world.state.travel)).toMatchObject({
      state: "transit",
      progress: 12 / 30,
      fromPortId: TINY.port,
      toPortId: TINY.port2,
      drifting: false,
    });
  });
});

describe("doorOpenFraction", () => {
  it("reads 0 shut or jammed, 1 open, and the leaf's travel in between", () => {
    expect(doorOpenFraction({ physicalState: "closed", transitionProgress: 0 })).toBe(0);
    expect(doorOpenFraction({ physicalState: "jammed", transitionProgress: 0.6 })).toBe(0);
    expect(doorOpenFraction({ physicalState: "open", transitionProgress: 0 })).toBe(1);
    expect(doorOpenFraction({ physicalState: "opening", transitionProgress: 0.25 })).toBe(0.25);
    expect(doorOpenFraction({ physicalState: "closing", transitionProgress: 0.25 })).toBe(0.75);
  });
});

describe("formatEta", () => {
  it("uses seconds under a minute and minutes above", () => {
    expect(formatEta(0.2)).toBe("1 s");
    expect(formatEta(34)).toBe("34 s");
    expect(formatEta(125)).toBe("2 min 05 s");
  });
});

describe("renderItems", () => {
  it("projects the scenario's loose wrench and carried rations, never port stores", () => {
    const { world } = tinyTestWorld();
    world.state.jobs[JOB] = job("accepted");
    addFreight(world.state, "cargoToLoad", ["store", "deck", "carried"]);
    const items = renderItems(world.state, world.content);
    const byName = (name: string) => items.filter((i) => i.name === name);

    expect(byName("Wrench")).toEqual([
      expect.objectContaining({
        kind: "tool",
        count: 1,
        location: expect.objectContaining({ kind: "deck" }),
      }),
    ]);
    expect(byName("Ration pack")).toEqual([
      expect.objectContaining({
        kind: "food",
        count: 3,
        location: { kind: "carried", actorId: "a1" },
      }),
    ]);
    const crates = byName("Crate");
    expect(crates.map((c) => c.id).sort()).toEqual(["i.c2", "i.c3"]);
    expect(crates[0]).toMatchObject({ kind: "crate", cargoClass: "general", jobId: JOB });
    expect(items.some((i) => i.id === "i.c1")).toBe(false);
  });

  it("keeps an item inside a container only while the container is aboard", () => {
    const { world } = tinyTestWorld();
    addFreight(world.state, "cargoToLoad", ["store", "deck"]);
    const ration = Object.values(world.state.items).find((i) => i.defId === TINY.rations);
    if (ration === undefined) throw new Error("no rations");
    ration.location = { kind: "inContainer", containerId: CRATES[1] as ItemId };
    expect(
      renderItems(world.state, world.content).find((i) => i.id === ration.id)?.location,
    ).toEqual({ kind: "container", containerId: CRATES[1] });
    ration.location = { kind: "inContainer", containerId: CRATES[0] as ItemId };
    expect(renderItems(world.state, world.content).some((i) => i.id === ration.id)).toBe(false);
  });

  it("is on the render frame alongside the headline", () => {
    const { world, kernel } = tinyTestWorld();
    const frame = kernel.getRenderFrame(world);
    expect(frame.headline).toBe("Docked at Tiny Dock — looking for work");
    expect(frame.items.length).toBe(2);
  });
});
