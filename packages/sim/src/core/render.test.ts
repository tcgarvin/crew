/**
 * Polish A: the render frame's items-aboard projection (§rooms-items-and-cargo) and ship headline
 * (§the-ship-headline).
 */
import { describe, expect, it } from "vitest";
import { tinyTestWorld } from "./fixtures/test-world";
import { TINY } from "./fixtures/tiny-content";
import {
  describeEvent,
  doorOpenFraction,
  formatEta,
  isTickerEvent,
  renderItems,
  renderTravel,
  shipHeadline,
  tickerLine,
} from "./render";
import { EVENT_SIGNIFICANCE, type SimEvent } from "./types/events";
import type {
  ActorId,
  DecisionId,
  EventId,
  HazardId,
  ItemId,
  JobId,
  MachineId,
  PortDefId,
  ProblemId,
} from "./types/ids";
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
  return shipHeadline(state, content, { nominalSpeed: 1, limpSpeedFraction: 0 });
}

describe("shipHeadline", () => {
  it("says the ship is looking for work when docked with nothing on", () => {
    const { world } = tinyTestWorld();
    expect(headline(world.state)).toBe("Docked at Tiny Dock — looking for work");
  });

  it("says the ship is set down at a landing site, with no work to look for", () => {
    const { world } = tinyTestWorld();
    const content = world.content;
    const port = content.ports[TINY.port];
    if (port === undefined) throw new Error("tiny content has no port");
    const siteContent = {
      ...content,
      ports: { ...content.ports, [TINY.port]: { ...port, kind: "site" as const } },
    };
    expect(headline(world.state, siteContent)).toBe("Set down at Tiny Dock");
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
    expect(headline(world.state)).toBe("Waiting for Mara Voss — docked at Tiny Dock");
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

  it("says the departure waits on a course while one is to plot (§course-plotting)", () => {
    const { world } = tinyTestWorld();
    world.state.travel = { stage: "docked", portId: TINY.port, plannedDestinationId: TINY.port2 };
    const id = "p.course" as ProblemId;
    world.state.work.problems[id] = {
      id,
      kind: "courseToPlot",
      payload: { toPortId: TINY.port2 },
      owner: "travel",
      visibility: "public",
      dedupeKey: "courseToPlot",
      status: "open",
      createdTick: 0,
      revision: 1,
      baseUrgency: "essentialOperation",
      location: { kind: "port", portId: TINY.port },
    };
    expect(headline(world.state)).toBe("Preparing to depart for Far Dock — waiting on a course");
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

  it("waits for the helm in prep and docking only while it is empty, not while its post is open (§helm-vacancy)", () => {
    const { world } = tinyTestWorld();
    // The watch post is open for the whole of underway; on its own it says nothing.
    const id = "p.watch" as ProblemId;
    world.state.work.problems[id] = {
      id,
      kind: "stationToStaff",
      payload: { machineId: "m.helm" as MachineId, post: "watch" },
      owner: "watch",
      visibility: "public",
      dedupeKey: "stationToStaff:watch",
      status: "open",
      createdTick: 0,
      revision: 1,
      baseUrgency: "essentialOperation",
      location: { kind: "machine", machineId: "m.helm" as MachineId },
    };
    underway(world.state, "preparingDeparture");
    expect(headline(world.state)).toBe("Preparing to depart for Far Dock");
    underway(world.state, "docking");
    expect(headline(world.state)).toBe("Docking at Far Dock");

    world.state.watch.helm.unattendedSinceTick = 0;
    underway(world.state, "preparingDeparture");
    expect(headline(world.state)).toBe(
      "Preparing to depart for Far Dock — waiting for someone at the helm",
    );
    underway(world.state, "docking");
    expect(headline(world.state)).toBe("Docking at Far Dock — waiting for someone at the helm");
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

describe("ticker lines for the watch and the helm (§the-bell, §hazard-roll)", () => {
  const { world } = tinyTestWorld();
  const mara = "a1" as ActorId;
  const pump = Object.values(world.state.machines)[0]?.id as MachineId;
  let seq = 0;
  const line = (draft: Pick<SimEvent, "type" | "payload" | "significance">): string =>
    describeEvent(
      {
        id: `e${++seq}` as EventId,
        tick: 1,
        seq,
        subjectIds: [],
        causeIds: [],
        source: "sim",
        ...draft,
      } as SimEvent,
      world.state,
      world.content,
    );
  const hazard = {
    hazardId: "h1" as HazardId,
    kind: "debrisField",
    difficulty: 5,
    skill: 6,
  } as const;

  it("rings the bell with the section that has the watch", () => {
    expect(line({ type: "bell", significance: "notable", payload: { watchIndex: 4 } })).toBe(
      "Bell.",
    );
    expect(
      line({
        type: "bell",
        significance: "notable",
        payload: { watchIndex: 4, sectionKey: "white" },
      }),
    ).toBe("Bell. White section has the watch.");
  });

  it("says who took the helm, from whom, and when nobody has it", () => {
    expect(
      line({
        type: "helmRelieved",
        significance: "notable",
        payload: { machineId: pump, byActorId: mara },
      }),
    ).toBe("Mara Voss takes the helm");
    expect(
      line({
        type: "helmRelieved",
        significance: "notable",
        payload: { machineId: pump, byActorId: mara, fromActorId: mara },
      }),
    ).toBe("Mara Voss relieves Mara Voss at the helm");
    expect(
      line({
        type: "helmUnattended",
        significance: "narrative",
        payload: { machineId: pump, seconds: 20 },
      }),
    ).toBe("Nobody at the helm");
  });

  it("names the plotted course and each hazard outcome", () => {
    expect(
      line({
        type: "coursePlotted",
        significance: "notable",
        payload: { toPortId: TINY.port2, actorId: mara },
      }),
    ).toBe("Course plotted for Far Dock");
    type NavPayload = Extract<SimEvent, { type: "navHazard" }>["payload"];
    const nav = (payload: Partial<NavPayload>) =>
      line({
        type: "navHazard",
        significance: "narrative",
        payload: { ...hazard, outcome: "clean", lostSeconds: 0, ...payload },
      });
    expect(nav({ standerId: mara })).toBe("Debris field: Mara Voss took us through clean");
    expect(nav({ outcome: "scrape", scrapedMachineId: pump })).toBe(
      "Debris field: scraped through, the coolant pump took it",
    );
    expect(nav({ outcome: "delay", lostSeconds: 60 })).toBe(
      "Debris field: lost 60 s working round it",
    );
    expect(nav({ outcome: "unattended", scrapedMachineId: pump, lostSeconds: 60 })).toBe(
      "Debris field: nobody at the helm; scraped through and lost 60 s",
    );
  });
});

describe("expeditions A2: setting down, lifting off, and the errand's lines", () => {
  /** The tiny content with `portId` a landing site ("The Far Site" when it is `port2`). */
  function withSite(portId: PortDefId) {
    const { world } = tinyTestWorld();
    const port = world.content.ports[portId];
    if (port === undefined) throw new Error(`tiny content has no ${portId}`);
    const content = {
      ...world.content,
      ports: { ...world.content.ports, [portId]: { ...port, kind: "site" as const } },
    };
    return { world, content };
  }

  it("sets down at a site on the approach and while docking, never 'Approaching' or 'Docking at'", () => {
    const { world, content } = withSite(TINY.port2);
    underway(world.state, "approaching");
    expect(headline(world.state, content)).toBe("Setting down at Far Dock");
    underway(world.state, "docking");
    expect(headline(world.state, content)).toBe("Setting down at Far Dock");
    world.state.watch.helm.unattendedSinceTick = 0;
    expect(headline(world.state, content)).toBe(
      "Setting down at Far Dock — waiting for someone at the helm",
    );
  });

  it("lifts off from a site while undocking and departing", () => {
    const { world, content } = withSite(TINY.port);
    underway(world.state, "undocking");
    expect(headline(world.state, content)).toBe("Lifting off from Tiny Dock — bound for Far Dock");
    underway(world.state, "departing");
    expect(headline(world.state, content)).toBe("Lifting off from Tiny Dock — bound for Far Dock");
  });

  it("is set down at a site with a course to lift off for, never 'Stopping at'", () => {
    const { world, content } = withSite(TINY.port);
    world.state.travel = { stage: "docked", portId: TINY.port, plannedDestinationId: TINY.port2 };
    expect(headline(world.state, content)).toBe("Set down at Tiny Dock — lifting off for Far Dock");
    world.state.travel.voyageDestinationId = TINY.port3;
    expect(headline(world.state, content)).toBe(
      "Set down at Tiny Dock — lifting off for Beyond Dock",
    );
    world.state.travel = { stage: "docked", portId: TINY.port, voyageDestinationId: TINY.port3 };
    expect(headline(world.state, content)).toBe(
      "Set down at Tiny Dock — lifting off for Beyond Dock",
    );
  });

  it("at the port a job starts from, is preparing to depart on the voyage, not stopping on the way", () => {
    const { world, content } = withSite(TINY.port3);
    world.state.jobs[JOB] = { ...job("accepted"), fromPortId: TINY.port, toPortId: TINY.port };
    world.state.travel = {
      stage: "docked",
      portId: TINY.port,
      plannedDestinationId: TINY.port2,
      voyageDestinationId: TINY.port3,
    };
    expect(headline(world.state, content)).toBe(
      "Preparing to depart for Far Dock, bound for Beyond Dock",
    );
    world.state.jobs[JOB] = { ...job("inTransit"), fromPortId: TINY.port, toPortId: TINY.port };
    expect(headline(world.state, content)).toMatch(/^Stopping at Tiny Dock on the way to /);
  });

  it("tells setting down and lifting off in the stage lines, and keeps the header steady until contact", () => {
    const { world, content } = withSite(TINY.port2);
    underway(world.state, "docking");
    const stage = (to: "docking" | "undocking") =>
      describeEvent(
        {
          id: "e.stage" as EventId,
          tick: 1,
          seq: 1,
          subjectIds: [],
          causeIds: [],
          source: "sim",
          type: "travelStageChanged",
          significance: "trace",
          payload: { from: "approaching", to },
        } as SimEvent,
        world.state,
        content,
      );
    expect(stage("docking")).toBe("Setting down");
    world.state.travel = { stage: "docked", portId: TINY.port2 };
    expect(
      isTickerEvent({
        id: "e.p" as EventId,
        tick: 1,
        seq: 1,
        subjectIds: [],
        causeIds: [],
        source: "sim",
        type: "policyDecisionNeeded",
        significance: "narrative",
        payload: { decisionId: "d1" as DecisionId },
      }),
    ).toBe(false);
  });

  describe("the ticker", () => {
    const { world, content } = withSite(TINY.port2);
    world.state.jobs[JOB] = {
      ...job("offered"),
      issuer: "Ysolde Maren, Meridian Growers",
      issuerPerson: { name: "Ysolde Maren", role: "grower", org: "Meridian Growers" },
      toPortId: TINY.port,
      cargo: [],
      errand: {
        kind: "fetchPerson",
        siteId: TINY.port2,
        targetName: "Corran Vale",
        wants: "alive",
        returnToPortId: TINY.port,
      },
    };
    let seq = 0;
    const line = (draft: Pick<SimEvent, "type" | "payload" | "significance">): string =>
      describeEvent(
        {
          id: `e${++seq}` as EventId,
          tick: 1,
          seq,
          subjectIds: [],
          causeIds: [],
          source: "sim",
          ...draft,
        } as SimEvent,
        world.state,
        content,
      );
    const failed = (outcome: Extract<SimEvent, { type: "jobFailed" }>["payload"]["outcome"]) =>
      line({ type: "jobFailed", significance: "narrative", payload: { jobId: JOB, outcome } });

    it("says the job for the issuer is lost, and why", () => {
      expect(failed("failed")).toBe(
        "The job for Ysolde Maren is lost: the party came back without Corran Vale",
      );
      world.state.expedition = {
        siteId: TINY.port2,
        phase: "resolved",
        party: [],
        leaderId: "a1" as ActorId,
        startedTick: 0,
        shots: 0,
        outcome: "targetFled",
        jobId: JOB,
      };
      expect(failed("failed")).toBe("The job for Ysolde Maren is lost: Corran Vale got away");
      expect(failed("putOff")).toBe("The job for Ysolde Maren is lost: Corran Vale was put off");
      expect(failed("leftBehind")).toBe(
        "The job for Ysolde Maren is lost: Corran Vale was left behind",
      );
    });

    it("is a narrative event, so it reaches the ticker", () => {
      expect(
        tickerLine(
          {
            id: "e.failed" as EventId,
            tick: 1,
            seq: 1,
            subjectIds: [JOB],
            causeIds: [],
            source: "sim",
            type: "jobFailed",
            significance: EVENT_SIGNIFICANCE.jobFailed,
            payload: { jobId: JOB, outcome: "failed" },
          },
          world.state,
          content,
        ),
      ).toMatch(/^The job for Ysolde Maren is lost: /);
    });

    it("says how the site noticed us when the narrator marked the arrival card (D105)", () => {
      const resolved = (
        extra: Partial<Extract<SimEvent, { type: "expeditionResolved" }>["payload"]>,
      ) =>
        line({
          type: "expeditionResolved",
          significance: "narrative",
          payload: {
            siteId: TINY.port2,
            outcome: "targetTaken",
            targetName: "The strongbox papers",
            seconds: 40,
            shots: 0,
            woundsUs: 0,
            hurtUs: 0,
            woundsThem: 0,
            deadUs: 0,
            deadThem: 0,
            ...extra,
          },
        });
      expect(resolved({})).toBe("The strongbox papers taken");
      expect(resolved({ notice: "unseen" })).toBe("The strongbox papers taken; nobody saw us");
      // Unseen, then our own first shot: the fight tells itself.
      expect(resolved({ notice: "unseen", shots: 3 })).toBe("The strongbox papers taken");
      expect(resolved({ notice: "seen", shots: 9, hurtUs: 1 })).toBe(
        "The strongbox papers taken; one of ours hurt; they were waiting for us",
      );
      expect(resolved({ notice: "seen", outcome: "partyRouted" })).toBe(
        "The party is driven back to the ship; they were waiting for us",
      );
    });

    it("names what a site keeps nothing of, and the site mid-sentence", () => {
      expect(
        line({
          type: "leftOnDock",
          significance: "notable",
          payload: { itemId: "i.gone" as ItemId, defId: TINY.wrench, portId: TINY.port2 },
        }),
      ).toBe("Left wrench behind at Far Dock");
      expect(
        line({
          type: "expeditionContact",
          significance: "narrative",
          payload: { siteId: TINY.port2 },
        }),
      ).toBe("Shots at Far Dock");
    });

    it("says nothing on starting, and goes down the ramp once the party is armed", () => {
      const leader = Object.values(world.state.actors).find((a) => a.crew);
      if (leader === undefined) throw new Error("fixture has no crew");
      const party = [leader.id, "a.second" as ActorId, "a.third" as ActorId];
      expect(
        tickerLine(
          {
            id: "e.started" as EventId,
            tick: 1,
            seq: 1,
            subjectIds: [],
            causeIds: [],
            source: "sim",
            type: "expeditionStarted",
            significance: EVENT_SIGNIFICANCE.expeditionStarted,
            payload: { siteId: TINY.port2, party },
          },
          world.state,
          content,
        ),
      ).toBeNull();
      expect(
        line({ type: "arrived", significance: "notable", payload: { portId: TINY.port2 } }),
      ).toBe("Set down at Far Dock");
      expect(
        line({ type: "partyMustered", significance: "trace", payload: { party, armed: party } }),
      ).toBe(`${leader.name} takes two down the ramp`);
    });

    it("tells an errand's offer and its completion by the target, not as freight or a fare", () => {
      expect(line({ type: "jobOffered", significance: "notable", payload: { jobId: JOB } })).toBe(
        "Ysolde Maren wants Corran Vale brought back from Far Dock",
      );
      expect(
        line({ type: "contractCompleted", significance: "narrative", payload: { jobId: JOB } }),
      ).toBe("Brought Corran Vale back for Ysolde Maren");
    });
  });
});

describe("the ticker line for a treatment (§treatment-at-the-medbay-bed)", () => {
  const { world } = tinyTestWorld();
  const [patientId, medicId] = Object.keys(world.state.actors) as ActorId[];
  const name = (id: ActorId | undefined) => (id === undefined ? "" : world.state.actors[id]?.name);
  const line = (parts: readonly ("leftLeg" | "rightLeg" | "torso" | "head")[]) =>
    describeEvent(
      {
        id: "e1" as EventId,
        tick: 1,
        seq: 1,
        subjectIds: [],
        causeIds: [],
        source: "sim",
        type: "woundTreated",
        significance: "notable",
        payload: {
          actorId: patientId as ActorId,
          byActorId: (medicId ?? patientId) as ActorId,
          woundIds: [],
          parts,
        },
      } as SimEvent,
      world.state,
      world.content,
    );

  it("names the medic, the patient and where they were hurt, each region once", () => {
    const medic = name(medicId ?? patientId);
    const patient = name(patientId);
    expect(line(["leftLeg"])).toBe(`${medic} treats ${patient}'s leg`);
    expect(line(["leftLeg", "rightLeg", "torso"])).toBe(
      `${medic} treats ${patient}'s leg and chest`,
    );
  });

  it("reaches the ticker; a wound healing does not", () => {
    expect(EVENT_SIGNIFICANCE.woundTreated).toBe("notable");
    expect(EVENT_SIGNIFICANCE.woundHealed).toBe("trace");
  });
});

describe("the ticker line for an accident (§accidents-aboard)", () => {
  const { world } = tinyTestWorld();
  const [actorId] = Object.keys(world.state.actors) as ActorId[];
  const event = (type: "accident" | "wounded", payload: unknown) =>
    ({
      id: "e1" as EventId,
      tick: 1,
      seq: 1,
      subjectIds: [],
      causeIds: [],
      source: "sim",
      type,
      significance: "notable",
      payload,
    }) as SimEvent;

  it("is the accident's own line, and its wound adds none", () => {
    const how = "someone is thrown off their feet by the impact";
    expect(
      tickerLine(event("accident", { actorId, hazard: "thrown", how }), world.state, world.content),
    ).toBe("Someone is thrown off their feet by the impact");
    expect(
      tickerLine(
        event("wounded", {
          actorId,
          woundId: "w1",
          part: "torso",
          severity: "graze",
          type: "blunt",
          narrated: true,
        }),
        world.state,
        world.content,
      ),
    ).toBeNull();
    expect(EVENT_SIGNIFICANCE.accident).toBe("notable");
  });
});
