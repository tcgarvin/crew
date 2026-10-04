import { describe, expect, it } from "vitest";
import { watchTicks } from "../../core/clock";
import { cmd } from "../../core/fixtures/test-world";
import type { TestWorld } from "../../core/fixtures/test-world";
import { allocateId } from "../../core/ids";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, HazardId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { TravelStage } from "../../core/types/travel";
import { PORTS, advanceThroughHooks } from "../travel/fixtures";
import {
  BETTINA,
  DANE,
  GANGWAY,
  JAX,
  MARA,
  NOOR,
  PRIYA,
  SEAT,
  STANDBY,
  bridgeConfig,
  bridgeWorld,
  placeOnBridgeDeck,
} from "./fixtures/bridge-deck";
import { helmRoleOf, helmWatchOf, isOfficerOfTheWatch, whoHasTheHelm } from "./helm";

type EventOf<T extends SimEvent["type"]> = Extract<SimEvent, { type: T }>;

/** The fixture with the ship slowed so a leg spans the given seconds of transit (route 25). */
function slowWorld(transitSeconds: number): TestWorld {
  const base = bridgeConfig();
  const config = { ...base, travel: { ...base.travel, nominalSpeed: 25 / transitSeconds } };
  return bridgeWorld({ config });
}

const secondsOf = (world: World, seconds: number) =>
  Math.round(seconds * world.config.values.time.tickRate);

const helmCtx = (world: World) => ({
  state: world.state,
  content: world.content,
  config: world.config.values,
  tick: world.state.tick,
});

const roleOf = (world: World, actorId: ActorId) => helmRoleOf(helmCtx(world), actorId);
const holder = (world: World) => whoHasTheHelm(world.state, world.content);
const labelOf = (world: World, actorId: ActorId) => {
  const activity = world.state.actors[actorId]?.activity;
  return activity === undefined || activity.kind === "idle" ? "idle" : activity.label;
};
const tileOf = (world: World, actorId: ActorId) => {
  const location = world.state.actors[actorId]?.location;
  if (location?.kind !== "onDeck") throw new Error(`${actorId} is not on deck`);
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
};

function setCourse(fixture: TestWorld): void {
  fixture.kernel.enqueueCommand(
    fixture.world,
    cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
  );
}

/**
 * Set a course and plot it by hand (D78's plot is the nav terminal's story, not the helm's): the
 * helm watch opens at once.
 */
function setPlottedCourse(fixture: TestWorld): void {
  setCourse(fixture);
  advanceThroughHooks(fixture.kernel, fixture.world, 1);
  const travel = fixture.world.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId === undefined) {
    throw new Error("no course planned in port");
  }
  travel.coursePlotted = true;
}

/**
 * Advance one tick at a time (so `check` sees every tick) until `until` holds, collecting the
 * events. Throws if `maxSeconds` runs out first.
 */
function runUntil(
  fixture: TestWorld,
  maxSeconds: number,
  until: (world: World) => boolean,
  check?: (world: World) => void,
): SimEvent[] {
  const events: SimEvent[] = [];
  const { world, kernel } = fixture;
  for (let i = 0; i < secondsOf(world, maxSeconds); i++) {
    if (until(world)) return events;
    events.push(...advanceThroughHooks(kernel, world, 1).events);
    check?.(world);
  }
  if (until(world)) return events;
  throw new Error(`condition not met within ${maxSeconds} s (tick ${world.state.tick})`);
}

function runFor(fixture: TestWorld, seconds: number, check?: (world: World) => void): SimEvent[] {
  const end = fixture.world.state.tick + secondsOf(fixture.world, seconds);
  return runUntil(fixture, seconds + 1, (w) => w.state.tick >= end, check);
}

const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is EventOf<T> => e.type === type);

const stage = (world: World): TravelStage => world.state.travel.stage;

/** Who claimed a `staffStation` task, by the claim events. */
function helmClaimants(world: World, events: readonly SimEvent[]): ActorId[] {
  const out = new Set<ActorId>();
  for (const event of ofType(events, "taskClaimed")) {
    const task = world.state.work.tasks[event.payload.taskId];
    if (task?.type === "staffStation") out.add(event.subjectIds[0] as ActorId);
  }
  return [...out];
}

function setUnavailable(world: World, actorIds: readonly ActorId[], how = "incapacitated") {
  for (const id of actorIds) {
    const actor = world.state.actors[id];
    if (actor === undefined) throw new Error(`no actor ${id}`);
    actor.availability = how as typeof actor.availability;
  }
}

const MANOEUVRES: readonly TravelStage[] = ["approaching", "docking"];

describe("who stands the helm (D77)", () => {
  it("Noor stands Red's helm with Mara aboard, Jax White's, Dane Blue's; Mara is officer of the watch", () => {
    const fixture = bridgeWorld();
    const { world } = fixture;
    expect(roleOf(world, NOOR)).toBe("stander");
    expect(roleOf(world, MARA)).toBe("none");
    expect(roleOf(world, PRIYA)).toBe("none");
    expect(isOfficerOfTheWatch(helmCtx(world), MARA)).toBe(true);
    expect(isOfficerOfTheWatch(helmCtx(world), NOOR)).toBe(false);
    const watch = watchTicks(world.config.values);
    const at = (tick: number) => ({ ...helmCtx(world), tick });
    expect(helmWatchOf(at(watch + 10))?.stander).toBe(JAX);
    expect(helmWatchOf(at(2 * watch + 10))?.stander).toBe(DANE);
    // In port with no course Dane stands no helm and no gangway (an officer): he has the watch.
    expect(isOfficerOfTheWatch(at(2 * watch + 10), DANE)).toBe(true);
    // From 30 s before the bell the next section's stander is the oncoming.
    const lead = secondsOf(world, 30);
    expect(helmWatchOf(at(watch - lead - 1))?.oncoming).toBeUndefined();
    expect(helmWatchOf(at(watch - lead))?.oncoming).toBe(JAX);
    expect(helmRoleOf(at(watch - lead), JAX)).toBe("oncoming");
  });

  it("with Noor ashore, Mara stands it and takes the helm", () => {
    const fixture = bridgeWorld();
    const { world } = fixture;
    setUnavailable(world, [NOOR], "offShip");
    expect(roleOf(world, MARA)).toBe("stander");
    setCourse(fixture);
    runUntil(fixture, 15, (w) => holder(w) === MARA);
    expect(labelOf(world, MARA)).toBe("at the helm");
  });

  it("the engineer at the helm (Priya): never while anyone qualified is aboard, and as the fallback when nobody is", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setUnavailable(world, [NOOR, MARA], "offShip");
    // Red has no qualified hand aboard: Jax, off watch, is nearer the bill than Priya's piloting 1.
    expect(roleOf(world, JAX)).toBe("stander");
    expect(roleOf(world, PRIYA)).toBe("none");
    setUnavailable(world, [JAX, DANE], "offShip");
    expect(roleOf(world, PRIYA)).toBe("stander");
    expect(roleOf(world, BETTINA)).toBe("none");
    // Nobody aboard can plot (D78 asks the helm's piloting), so the course is plotted by hand.
    setPlottedCourse(fixture);
    runUntil(fixture, 15, (w) => holder(w) === PRIYA);
    expect(labelOf(world, PRIYA)).toBe("at the helm");
    // Jax back aboard: he relieves her.
    setUnavailable(world, [JAX], "available");
    const events = runUntil(fixture, 30, (w) => holder(w) === JAX);
    expect(ofType(events, "helmRelieved").map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ byActorId: JAX, fromActorId: PRIYA }),
    );
  });
});

describe("taking the helm (the slice 1 QA case)", () => {
  it("an idle, on-watch, qualified stander takes the helm promptly, and nobody else claims it", () => {
    const fixture = bridgeWorld();
    const { world } = fixture;
    runFor(fixture, 2);
    // Noor idle five tiles from the helm; the captain at the far end of the ship.
    placeOnBridgeDeck(world, NOOR, { x: 7, y: 1 });
    placeOnBridgeDeck(world, MARA, { x: 1, y: 2 });
    setPlottedCourse(fixture);
    const start = world.state.tick;
    const events = runUntil(fixture, 10, (w) => holder(w) === NOOR);
    expect(world.state.tick - start).toBeLessThan(secondsOf(world, 6));
    expect(helmClaimants(world, events)).toEqual([NOOR]);
    expect(ofType(events, "helmRelieved").map((e) => e.payload)).toEqual([
      expect.objectContaining({ byActorId: NOOR }),
    ]);
  });

  it("never leaves the helm empty through a manoeuvre while a qualified hand is idle aboard", () => {
    const fixture = bridgeWorld();
    const { world } = fixture;
    runFor(fixture, 2);
    setCourse(fixture);
    const emptyThrough: string[] = [];
    runUntil(
      fixture,
      60,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === PORTS.b,
      (w) => {
        if (MANOEUVRES.includes(stage(w)) && holder(w) === undefined) {
          emptyThrough.push(`${w.state.tick} ${stage(w)}`);
        }
      },
    );
    expect(emptyThrough).toEqual([]);
  });

  it("a stander busy eating does not hold up the departure: the officer of the watch takes it, then Noor relieves her", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    runFor(fixture, 2);
    placeOnBridgeDeck(world, MARA, { x: 10, y: 1 });
    const noor = world.state.actors[NOOR];
    if (noor === undefined) throw new Error("no Noor");
    noor.needs.hunger = 0.8;
    runUntil(fixture, 10, (w) => labelOf(w, NOOR) === "eating");
    setCourse(fixture);
    const events = runUntil(fixture, 10, (w) => holder(w) === MARA);
    // Still the stander, but not called to a helm Mara has while she is hungry.
    expect(helmWatchOf(helmCtx(world))?.stander).toBe(NOOR);
    const hungry = noor.needs.hunger > world.config.values.urgency.needEssentialAbove;
    expect(roleOf(world, NOOR)).toBe(hungry ? "none" : "stander");
    events.push(...runUntil(fixture, 30, (w) => holder(w) === NOOR));
    expect(ofType(events, "ateMeal").map((e) => e.subjectIds[0])).toContain(NOOR);
    expect(ofType(events, "helmRelieved").map((e) => e.payload)).toEqual([
      expect.objectContaining({ byActorId: MARA }),
      expect.objectContaining({ byActorId: NOOR, fromActorId: MARA }),
    ]);
  });
});

describe("handover at the bell (D77)", () => {
  it("the oncoming walks to standby 30 s before the bell, relieves in 5 s, and takes the seat at once", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setCourse(fixture);
    runUntil(fixture, 20, (w) => stage(w) === "transit" && holder(w) === NOOR);
    const watch = watchTicks(world.config.values);
    const lead = secondsOf(world, 30);
    runUntil(fixture, 100, (w) => w.state.tick >= watch - lead);
    expect(roleOf(world, JAX)).toBe("oncoming");
    let atStandby: number | undefined;
    const events = runUntil(
      fixture,
      40,
      (w) => holder(w) === JAX,
      (w) => {
        if (atStandby === undefined && labelOf(w, JAX) === "relieving Noor Haddad at the helm") {
          expect(tileOf(w, JAX)).toEqual(STANDBY);
          atStandby = w.state.tick;
        }
      },
    );
    expect(world.state.tick).toBeLessThan(watch);
    const relieved = ofType(events, "helmRelieved");
    expect(relieved.map((e) => e.payload)).toEqual([
      { machineId: expect.any(String), byActorId: JAX, fromActorId: NOOR },
    ]);
    const relief = relieved[0];
    if (relief === undefined || atStandby === undefined) throw new Error("no handover");
    // The 5 s handover, counted from its first tick at standby.
    expect(relief.tick - atStandby).toBe(secondsOf(world, 5) - 1);
    // The seat race: Noor steps off and Jax sits within a moment, with no failed step.
    expect(world.state.tick - relief.tick).toBeLessThanOrEqual(secondsOf(world, 1.5));
    const failures = [...ofType(events, "actionFailed"), ...ofType(events, "taskBlocked")];
    expect(failures.filter((e) => e.subjectIds.some((id) => id === JAX || id === NOOR))).toEqual(
      [],
    );
    expect(tileOf(world, NOOR)).not.toEqual(SEAT);
    expect(labelOf(world, JAX)).toBe("at the helm");
    // After the bell Noor is no longer anyone at the helm, and Jax stands White's watch.
    runFor(fixture, secondsOf(world, 0) + 31);
    expect(holder(world)).toBe(JAX);
    expect(roleOf(world, JAX)).toBe("stander");
    expect(roleOf(world, NOOR)).toBe("none");
  });

  it("the off-going holds for a late oncoming and has a long watch, then a double watch", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setUnavailable(world, [JAX, DANE]);
    setCourse(fixture);
    const events = runUntil(fixture, 250, (w) => w.state.tick >= secondsOf(w, 215));
    expect(holder(world)).toBe(NOOR);
    const thoughts = ofType(events, "thoughtAdded").map((e) => e.payload);
    expect(thoughts).toEqual([
      { actorId: NOOR, key: "stoodLongWatch" },
      { actorId: NOOR, key: "doubleWatch" },
    ]);
    expect(world.state.actors[NOOR]?.thoughts.map((t) => t.key)).toEqual([
      "stoodLongWatch",
      "doubleWatch",
    ]);
  });

  it("teaches piloting at the helm, and only there", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setCourse(fixture);
    runUntil(fixture, 20, (w) => holder(w) === NOOR);
    const before = world.state.actors[NOOR]?.skills.piloting ?? 0;
    const mara = world.state.actors[MARA]?.skills.piloting;
    runFor(fixture, 30);
    const perSecond =
      world.config.values.work.skillGainPerDay / world.config.values.time.daySeconds;
    expect((world.state.actors[NOOR]?.skills.piloting ?? 0) - before).toBeCloseTo(
      30 * perSecond,
      2,
    );
    expect(world.state.actors[MARA]?.skills.piloting).toBe(mara);
  });
});

describe("relief for needs (D77)", () => {
  it("a hungry stander raises a relief, an off-watch pilot takes it, she eats, comes back, and the relief resolves", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setCourse(fixture);
    runUntil(fixture, 20, (w) => stage(w) === "transit" && holder(w) === NOOR);
    const noor = world.state.actors[NOOR];
    if (noor === undefined) throw new Error("no Noor");
    noor.needs.hunger = 0.75;
    const reliefOpen = (w: World) =>
      Object.values(w.state.work.problems).some(
        (p) => p.kind === "stationToStaff" && p.payload.post === "relief" && p.status === "open",
      );
    runFor(fixture, 0.2);
    expect(reliefOpen(world)).toBe(true);
    const events = runUntil(fixture, 50, (w) => holder(w) === NOOR && !reliefOpen(w));
    const relieved = ofType(events, "helmRelieved").map((e) => e.payload);
    const reliever = relieved[0]?.byActorId;
    expect([JAX, DANE]).toContain(reliever);
    expect(relieved).toEqual([
      expect.objectContaining({ byActorId: reliever, fromActorId: NOOR }),
      expect.objectContaining({ byActorId: NOOR, fromActorId: reliever }),
    ]);
    expect(ofType(events, "ateMeal").map((e) => e.subjectIds[0])).toContain(NOOR);
    expect(world.state.tick).toBeLessThan(watchTicks(world.config.values));
    // Relieved, she goes to eat rather than straight back to the empty seat in between.
    expect(ofType(events, "actionFailed")).toEqual([]);
  });

  it("a stander past survival leaves without relief, and the vacancy pulls the officer of the watch back", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setUnavailable(world, [JAX, DANE]);
    setCourse(fixture);
    runUntil(fixture, 20, (w) => stage(w) === "transit" && holder(w) === NOOR);
    const noor = world.state.actors[NOOR];
    if (noor === undefined) throw new Error("no Noor");
    noor.needs.hunger = 0.95;
    const events = runUntil(fixture, 30, (w) => holder(w) === MARA);
    expect(ofType(events, "helmRelieved").map((e) => e.payload)).toEqual([
      expect.objectContaining({ byActorId: MARA }),
    ]);
    expect(ofType(events, "helmRelieved")[0]?.payload.fromActorId).toBeUndefined();
    const meal = runUntil(fixture, 20, (w) => (w.state.actors[NOOR]?.needs.hunger ?? 1) < 0.5);
    expect(ofType(meal, "ateMeal").map((e) => e.subjectIds[0])).toContain(NOOR);
    expect(holder(world)).toBe(MARA);
  });
});

describe("vacancy is a gate, not a slowdown (D77)", () => {
  it("preparingDeparture stalls with nobody to take the helm, and goes once someone does", () => {
    const fixture = bridgeWorld();
    const { world } = fixture;
    const everyone = [NOOR, MARA, PRIYA, JAX, DANE, BETTINA];
    setUnavailable(world, everyone);
    setCourse(fixture);
    runFor(fixture, 0.1);
    // Nobody is up to plot it either; plotted by hand, so only the helm holds the ship (D78).
    const docked = world.state.travel;
    if (docked.stage !== "docked") throw new Error("left port");
    docked.coursePlotted = true;
    runFor(fixture, 10);
    expect(stage(world)).toBe("preparingDeparture");
    setUnavailable(world, [NOOR], "available");
    runUntil(fixture, 20, (w) => stage(w) === "transit");
  });

  it("in transit the ship flies on, and `helmUnattended` fires once after 20 s; approach and docking wait", () => {
    const fixture = slowWorld(60);
    const { world } = fixture;
    const everyone = [NOOR, MARA, PRIYA, JAX, DANE, BETTINA];
    setCourse(fixture);
    runUntil(fixture, 20, (w) => stage(w) === "transit");
    setUnavailable(world, everyone);
    const start = world.state.travel;
    if (start.stage !== "transit") throw new Error("not in transit");
    const from = start.routeProgress;
    const events = runFor(fixture, 70);
    const travel = world.state.travel;
    // The leg is flown to its end, and the approach does not begin.
    expect(travel.stage).toBe("transit");
    if (travel.stage !== "transit") throw new Error("left transit");
    expect(travel.routeProgress).toBeGreaterThan(from);
    expect(travel.routeProgress).toBe(travel.routeDistance);
    const unattended = ofType(events, "helmUnattended");
    expect(unattended.map((e) => e.payload)).toEqual([
      { machineId: expect.any(String), seconds: 20 },
    ]);
    expect(ofType(events, "travelStageChanged")).toEqual([]);
    // Approach and docking hold in place too.
    for (const held of ["approaching", "docking"] as const) {
      world.state.travel = { ...travel, stage: held, stageProgress: 0 };
      runFor(fixture, 3);
      expect(world.state.travel).toMatchObject({ stage: held, stageProgress: 0 });
    }
    setUnavailable(world, [NOOR], "available");
    runUntil(fixture, 30, (w) => stage(w) === "docked");
  });
});

describe("gangway watch (D77)", () => {
  it("docked, the stander stands the gangway, and leaves it for the helm when a course is set", () => {
    const fixture = bridgeWorld();
    const { world } = fixture;
    runUntil(fixture, 15, (w) => labelOf(w, NOOR) === "on the gangway");
    expect(tileOf(world, NOOR)).toEqual(GANGWAY);
    setCourse(fixture);
    runUntil(fixture, 15, (w) => holder(w) === NOOR);
  });

  it("is never stood by an officer: Blue's stander is the first officer, so nobody stands it", () => {
    const fixture = bridgeWorld();
    const { world } = fixture;
    runUntil(
      fixture,
      300,
      (w) => w.state.tick >= 2 * watchTicks(w.config.values) + secondsOf(w, 10),
    );
    expect(roleOf(world, DANE)).toBe("stander");
    expect(Object.values(world.state.actors).map((a) => labelOf(world, a.id))).not.toContain(
      "on the gangway",
    );
  });
});

describe("the helm's stakes: hazards are rolled by whoever has it (D77, D78)", () => {
  function scheduleHazardNow(world: World): void {
    const id = allocateId(world.state, "hazard") as HazardId;
    world.state.hazards.push({
      id,
      kind: "debrisField",
      difficulty: 5,
      fireAtTick: world.state.tick + 2,
    });
  }

  it("names the one in the seat as the stander", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setCourse(fixture);
    runUntil(fixture, 20, (w) => stage(w) === "transit" && holder(w) === NOOR);
    scheduleHazardNow(world);
    const [hazard] = ofType(runFor(fixture, 1), "navHazard");
    expect(hazard?.payload.standerId).toBe(NOOR);
    expect(hazard?.payload.standerId).toBe(holder(world));
    expect(hazard?.payload.outcome).not.toBe("unattended");
  });

  it("an empty helm on the leg is unattended", () => {
    const fixture = slowWorld(400);
    const { world } = fixture;
    setCourse(fixture);
    runUntil(fixture, 20, (w) => stage(w) === "transit");
    setUnavailable(world, [NOOR, MARA, PRIYA, JAX, DANE, BETTINA]);
    runFor(fixture, 0.5);
    expect(holder(world)).toBeUndefined();
    scheduleHazardNow(world);
    const [hazard] = ofType(runFor(fixture, 1), "navHazard");
    expect(hazard?.payload.outcome).toBe("unattended");
    expect(hazard?.payload.standerId).toBeUndefined();
  });
});
