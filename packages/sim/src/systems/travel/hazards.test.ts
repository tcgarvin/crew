import { beforeEach, describe, expect, it, vi } from "vitest";
import { configTicks } from "../../core/clock";
import { cmd } from "../../core/fixtures/test-world";
import { isTickerEvent } from "../../core/render";
import { createRngApi, seedStream } from "../../core/rng";
import type { Actor } from "../../core/types/actor";
import type { HazardKind } from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, CommandId } from "../../core/types/ids";
import { equipmentSystem } from "../equipment/equipment";
import { FIX, PORTS, advanceThroughHooks, advanceToStage, freightTestWorld } from "./fixtures";
import { cleanPassChance, hazardOutcome } from "./hazards";
import { travelViolations } from "./invariants";

/**
 * Test seam for the helm: `whoHasTheHelm` is W1's (a stub returning nobody until it lands), and
 * the freight fixture has no helm machine to seat anyone at, so these tests name the stander.
 */
const helm = vi.hoisted(() => ({ stander: undefined as ActorId | undefined }));
vi.mock("../watch/helm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../watch/helm")>();
  return { ...actual, whoHasTheHelm: () => helm.stander };
});

beforeEach(() => {
  helm.stander = undefined;
});

type Payload = { kind: HazardKind; difficulty: number; windowTicks: readonly [number, number] };
type Test = ReturnType<typeof freightTestWorld>;

function schedule(test: Test, payload: Payload) {
  return test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "scheduleHazard", payload }),
  );
}

const codeOf = (result: ReturnType<typeof schedule>) =>
  result.status === "rejected" ? result.rejection.code : result.status;

/** A planned course: `setCourse` while docked (applied at the next tick). */
function planCourse(test: Test, to: (typeof PORTS)[keyof typeof PORTS] = PORTS.b) {
  test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "setCourse", payload: { destinationPortId: to } }),
  );
  test.kernel.advance(test.world, 1);
}

/** One tick, acknowledging any hook on the way; the tick's events. */
function step(test: Test): readonly SimEvent[] {
  return advanceThroughHooks(test.kernel, test.world, 1).events;
}

/** Under way, far down a long leg, so a delay has a whole `delaySeconds` of distance to give back. */
function inTransit(test: Test) {
  planCourse(test);
  advanceToStage(test.kernel, test.world, "transit");
  const travel = test.world.state.travel;
  if (travel.stage !== "transit") throw new Error("not in transit");
  travel.routeDistance = 1_000;
  travel.routeProgress = 500;
  return travel;
}

/** Route distance the ship covers in one tick at full speed. */
function perTick(test: Test): number {
  const config = test.world.config.values;
  return config.travel.nominalSpeed / config.time.tickRate;
}

function captain(test: Test): Actor {
  const actor = Object.values(test.world.state.actors).find((a) => a.defId === FIX.captain);
  if (actor === undefined) throw new Error("no captain");
  return actor;
}

function engine(test: Test) {
  const machine = Object.values(test.world.state.machines).find((m) => m.defId === FIX.engine);
  if (machine === undefined) throw new Error("no engine");
  return machine;
}

/** The captain has the helm at piloting 5; a difficulty-5 hazard is then an even chance. */
function seatCaptain(test: Test): Actor {
  const actor = captain(test);
  actor.skills = { ...actor.skills, piloting: 5 };
  helm.stander = actor.id;
  return actor;
}

/**
 * Sets the `failures` stream so the next draw lands in [`min`, `max`): the hazard's roll, when
 * it is the first `failures` draw of its tick (nothing else in this fixture draws on it).
 */
function rigNextRoll(test: Test, min: number, max: number): void {
  for (let seed = 1; seed < 10_000; seed++) {
    const state = seedStream(seed, "failures");
    const probe = createRngApi({
      seed,
      rng: { ...test.world.state.rng, failures: state },
    }).float("failures");
    if (probe >= min && probe < max) {
      test.world.state.rng.failures = state;
      return;
    }
  }
  throw new Error(`no seed rolls in [${min}, ${max})`);
}

/** Schedules a difficulty-5 debris field due in `delay` ticks; returns its command id. */
function scheduleSoon(test: Test, delay = 2): CommandId {
  const command = cmd({
    source: "scenario",
    kind: "scheduleHazard",
    payload: { kind: "debrisField", difficulty: 5, windowTicks: [delay, delay] },
  });
  expect(test.kernel.enqueueCommand(test.world, command).status).toBe("accepted");
  step(test);
  return command.id;
}

/** Steps until the hazard fires; the navHazard event and the tick's events. */
function untilFired(test: Test, maxTicks = 500) {
  for (let i = 0; i < maxTicks; i++) {
    const events = step(test);
    const fired = events.find(
      (e): e is Extract<SimEvent, { type: "navHazard" }> => e.type === "navHazard",
    );
    if (fired !== undefined) return { fired, events };
    expect(travelViolations(test.world)).toEqual([]);
  }
  throw new Error("the hazard never fired");
}

const debris: Payload = { kind: "debrisField", difficulty: 5, windowTicks: [0, 200] };

describe("scheduleHazard (D78)", () => {
  it("needs a leg to lie on: a planned course or the ship under way", () => {
    const test = freightTestWorld();
    expect(codeOf(schedule(test, debris))).toBe("preconditionFailed");
    planCourse(test);
    expect(codeOf(schedule(test, debris))).toBe("accepted");
  });

  it("places the hazard in its window on the failures stream and spends the hazard budget", () => {
    const test = freightTestWorld();
    planCourse(test);
    const budget = test.world.state.narrator.budget.hazardsRemaining;
    const at = test.world.state.tick + 1;
    schedule(test, debris);
    const result = test.kernel.advance(test.world, 1);
    const [hazard] = test.world.state.hazards;
    expect(hazard).toMatchObject({ id: "h1", kind: "debrisField", difficulty: 5 });
    expect(hazard?.fireAtTick).toBeGreaterThanOrEqual(at);
    expect(hazard?.fireAtTick).toBeLessThanOrEqual(at + 200);
    expect(test.world.state.narrator.budget.hazardsRemaining).toBe(budget - 1);
    expect(test.world.state.nextId.hazard).toBe(2);
    const scheduled = result.events.find((e) => e.type === "hazardScheduled");
    expect(scheduled?.payload).toEqual({ hazardId: "h1", kind: "debrisField" });
  });

  it("rejects an unknown kind, a difficulty off the 1-10 scale, a bad or oversize window, and an empty budget", () => {
    const test = freightTestWorld();
    planCourse(test);
    const maxWindow = test.world.config.values.narrator.maxFaultWindowSeconds * 20;
    expect(codeOf(schedule(test, { ...debris, kind: "blackHole" as HazardKind }))).toBe(
      "invalidPayload",
    );
    for (const difficulty of [0, 11, 2.5]) {
      expect(codeOf(schedule(test, { ...debris, difficulty }))).toBe("invalidPayload");
    }
    expect(codeOf(schedule(test, { ...debris, windowTicks: [10, 5] }))).toBe("invalidPayload");
    expect(codeOf(schedule(test, { ...debris, windowTicks: [0, maxWindow + 1] }))).toBe(
      "outOfBounds",
    );
    test.world.state.narrator.budget.hazardsRemaining = 0;
    expect(codeOf(schedule(test, debris))).toBe("budgetExhausted");
  });

  it("is spent down to nothing and refilled every budgetRefillDays", () => {
    const test = freightTestWorld();
    planCourse(test);
    const full = test.world.config.values.narrator.hazardBudget;
    for (let i = 0; i < full; i++) {
      expect(codeOf(schedule(test, debris))).toBe("accepted");
      step(test);
    }
    expect(test.world.state.narrator.budget.hazardsRemaining).toBe(0);
    expect(codeOf(schedule(test, debris))).toBe("budgetExhausted");
    const config = test.world.config.values;
    const every = config.narrator.budgetRefillDays * config.time.daySeconds * config.time.tickRate;
    // Wind the last refill back so the next one is due on the coming tick.
    test.world.state.narrator.budgetRefilledTick = test.world.state.tick + 1 - every;
    step(test);
    expect(test.world.state.narrator.budget.hazardsRemaining).toBe(full);
    expect(codeOf(schedule(test, debris))).toBe("accepted");
  });
});

describe("the piloting check (D78)", () => {
  it("is an even chance at skill equal to difficulty, bounded to [0.05, 0.95]", () => {
    expect(cleanPassChance(5, 5)).toBe(0.5);
    expect(cleanPassChance(8, 5)).toBeCloseTo(0.8);
    expect(cleanPassChance(10, 1)).toBe(0.95);
    expect(cleanPassChance(0, 10)).toBe(0.05);
    // Below the clean chance a pass; the rest split evenly between a scrape and a delay.
    expect(hazardOutcome(0.5, 0.49)).toBe("clean");
    expect(hazardOutcome(0.5, 0.5)).toBe("scrape");
    expect(hazardOutcome(0.5, 0.74)).toBe("scrape");
    expect(hazardOutcome(0.5, 0.75)).toBe("delay");
  });
});

describe("hazardsSystem (D78)", () => {
  it("waits in port and through departure, and fires on the first tick of transit", () => {
    const test = freightTestWorld();
    planCourse(test);
    expect(codeOf(schedule(test, { ...debris, windowTicks: [0, 0] }))).toBe("accepted");
    step(test);
    const [hazard] = test.world.state.hazards;
    expect(hazard?.fireAtTick).toBe(test.world.state.tick);
    let stage = test.world.state.travel.stage;
    for (let i = 0; i < 500 && stage !== "transit"; i++) {
      const events = step(test);
      expect(events.some((e) => e.type === "navHazard")).toBe(
        test.world.state.travel.stage === "transit",
      );
      stage = test.world.state.travel.stage;
    }
    expect(stage).toBe("transit");
    expect(test.world.state.hazards).toEqual([]);
  });

  it("a clean pass: nothing breaks, nothing is lost, and the stander is pleased with it", () => {
    const test = freightTestWorld();
    inTransit(test);
    const stander = seatCaptain(test);
    const cause = scheduleSoon(test);
    rigNextRoll(test, 0, 0.5);
    const { fired } = untilFired(test);
    expect(fired.payload).toEqual({
      hazardId: "h1",
      kind: "debrisField",
      difficulty: 5,
      standerId: stander.id,
      skill: 5,
      outcome: "clean",
      lostSeconds: 0,
    });
    expect(fired.causeIds).toEqual([cause]);
    expect(fired.subjectIds).toEqual([stander.id]);
    expect(engine(test).scheduledFaults).toEqual([]);
    expect(stander.thoughts.map((t) => t.key)).toEqual(["helmCleanPass"]);
    expect(stander.mood).toBeCloseTo(test.world.content.thoughts.helmCleanPass.value);
  });

  it("a scrape: one fault on a machine, through the equipment path next tick", () => {
    const test = freightTestWorld();
    inTransit(test);
    const stander = seatCaptain(test);
    const cause = scheduleSoon(test);
    rigNextRoll(test, 0.5, 0.75);
    const { fired } = untilFired(test);
    expect(fired.payload).toMatchObject({
      outcome: "scrape",
      standerId: stander.id,
      scrapedMachineId: engine(test).id,
      lostSeconds: 0,
    });
    const [scheduled] = engine(test).scheduledFaults;
    expect(scheduled).toEqual({
      faultKey: expect.stringMatching(/^(wornBearing|hotPanel)$/),
      fireAtTick: test.world.state.tick + 1,
      causeCommandId: cause,
    });
    expect(stander.thoughts.map((t) => t.key)).toEqual(["helmScrape"]);
    // The fixture runs no equipment system; the real one picks the fault up on the next tick.
    test.registry.registerSystem(equipmentSystem);
    const events = step(test);
    expect(engine(test).faults.map((f) => f.faultKey)).toEqual([scheduled?.faultKey]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "faultOccurred",
        causeIds: [cause],
        payload: { machineId: engine(test).id, faultKey: scheduled?.faultKey },
      }),
    );
  });

  it("a scrape with no fault left to take breaks nothing more and names no machine", () => {
    const test = freightTestWorld();
    inTransit(test);
    seatCaptain(test);
    for (const faultKey of ["wornBearing", "hotPanel"]) {
      engine(test).faults.push({
        faultKey,
        sinceTick: 0,
        diagnosed: false,
        repairStepIndex: 0,
        repairStepProgress: 0,
      });
    }
    scheduleSoon(test);
    rigNextRoll(test, 0.5, 0.75);
    const { fired } = untilFired(test);
    expect(fired.payload.outcome).toBe("scrape");
    expect(fired.payload).not.toHaveProperty("scrapedMachineId");
    expect(engine(test).scheduledFaults).toEqual([]);
  });

  it("a delay: the leg set back delaySeconds at nominal speed, and no thought either way", () => {
    const test = freightTestWorld();
    const travel = inTransit(test);
    const stander = seatCaptain(test);
    scheduleSoon(test);
    rigNextRoll(test, 0.75, 1);
    const before = travel.routeProgress;
    const { fired } = untilFired(test);
    const config = test.world.config.values;
    expect(fired.payload).toMatchObject({
      outcome: "delay",
      lostSeconds: config.hazards.delaySeconds,
    });
    expect(fired.payload).not.toHaveProperty("scrapedMachineId");
    // Two ticks of travel up to and including the firing tick, less the delay.
    expect(travel.routeProgress).toBeCloseTo(
      before + 2 * perTick(test) - config.hazards.delaySeconds * config.travel.nominalSpeed,
    );
    expect(travel.stageProgress).toBeCloseTo(travel.routeProgress / travel.routeDistance);
    expect(engine(test).scheduledFaults).toEqual([]);
    expect(stander.thoughts).toEqual([]);
  });

  it("never sets the leg back past its start, and reports the time actually lost", () => {
    const test = freightTestWorld();
    const travel = inTransit(test);
    seatCaptain(test);
    scheduleSoon(test);
    rigNextRoll(test, 0.75, 1);
    travel.routeProgress = 0;
    const { fired } = untilFired(test);
    const config = test.world.config.values;
    expect(travel.routeProgress).toBe(0);
    expect(fired.payload.lostSeconds).toBeCloseTo((2 * perTick(test)) / config.travel.nominalSpeed);
  });

  it("an unattended helm takes the scrape and the delay both, with no roll and nobody to blame", () => {
    const test = freightTestWorld();
    inTransit(test);
    scheduleSoon(test);
    const { fired } = untilFired(test);
    const config = test.world.config.values;
    expect(fired.payload).toEqual({
      hazardId: "h1",
      kind: "debrisField",
      difficulty: 5,
      skill: 0,
      outcome: "unattended",
      scrapedMachineId: engine(test).id,
      lostSeconds: config.hazards.delaySeconds,
    });
    expect(fired.subjectIds).toEqual([engine(test).id]);
    expect(engine(test).scheduledFaults).toHaveLength(1);
    expect(Object.values(test.world.state.actors).every((a) => a.thoughts.length === 0)).toBe(true);
  });

  it("fires every hazard due on the same tick, each with its own roll", () => {
    const test = freightTestWorld();
    inTransit(test);
    scheduleSoon(test, 4);
    scheduleSoon(test, 3);
    const fired: SimEvent[] = [];
    for (let i = 0; i < 10; i++) fired.push(...step(test).filter((e) => e.type === "navHazard"));
    expect(fired.map((e) => e.payload)).toEqual([
      expect.objectContaining({ hazardId: "h1", outcome: "unattended" }),
      expect.objectContaining({ hazardId: "h2", outcome: "unattended" }),
    ]);
    expect(engine(test).scheduledFaults).toHaveLength(2);
    expect(test.world.state.hazards).toEqual([]);
  });
});

describe("a hazard lies on its own leg only (D78)", () => {
  it("is dropped the tick transit ends before it falls due, and never fires on a later leg", () => {
    const test = freightTestWorld();
    planCourse(test);
    const maxWindow = configTicks(
      test.world.config.values,
      test.world.config.values.narrator.maxFaultWindowSeconds,
    );
    const command = cmd({
      source: "scenario",
      kind: "scheduleHazard",
      payload: { kind: "ionStorm", difficulty: 7, windowTicks: [maxWindow, maxWindow] },
    });
    expect(test.kernel.enqueueCommand(test.world, command).status).toBe("accepted");
    const all: SimEvent[] = [...step(test)];
    const fireAtTick = test.world.state.hazards[0]?.fireAtTick ?? Number.NaN;
    const stage = () => test.world.state.travel.stage;
    for (let i = 0; i < 2_000 && stage() !== "approaching"; i++) {
      const events = step(test);
      all.push(...events);
      expect(travelViolations(test.world)).toEqual([]);
      const missed = events.filter((e) => e.type === "navHazardMissed");
      // Nothing is dropped while the leg still has transit ahead.
      expect(missed).toHaveLength(stage() === "approaching" ? 1 : 0);
    }
    expect(stage()).toBe("approaching");
    expect(test.world.state.tick).toBeLessThan(fireAtTick);
    expect(test.world.state.hazards).toEqual([]);
    const missed = all.find((e) => e.type === "navHazardMissed");
    expect(missed?.payload).toEqual({
      hazardId: "h1",
      kind: "ionStorm",
      difficulty: 7,
      fromPortId: PORTS.a,
      toPortId: PORTS.b,
    });
    expect(missed?.causeIds).toEqual([command.id]);
    expect(missed?.significance).toBe("notable");
    expect(missed !== undefined && isTickerEvent(missed)).toBe(false);
    // Back and forth on later legs, past the tick it would have fired: nothing does.
    let next: (typeof PORTS)[keyof typeof PORTS] = PORTS.a;
    for (let leg = 0; leg < 20 && test.world.state.tick <= fireAtTick; leg++) {
      advanceToStage(test.kernel, test.world, "docked");
      planCourse(test, next);
      next = next === PORTS.a ? PORTS.b : PORTS.a;
      for (let i = 0; i < 2_000 && test.world.state.travel.stage !== "approaching"; i++) {
        all.push(...step(test));
      }
    }
    expect(test.world.state.tick).toBeGreaterThan(fireAtTick);
    expect(all.some((e) => e.type === "navHazard")).toBe(false);
  });

  it("is dropped with the course when it is given up in port before the leg begins", () => {
    const test = freightTestWorld();
    const tick = test.world.state.tick;
    test.world.state.hazards = [
      { id: "h1" as never, kind: "asteroidBelt", difficulty: 3, fireAtTick: tick + 50 },
    ];
    const missed = step(test).find((e) => e.type === "navHazardMissed");
    expect(missed?.payload).toEqual({
      hazardId: "h1",
      kind: "asteroidBelt",
      difficulty: 3,
      fromPortId: PORTS.a,
    });
    expect(test.world.state.hazards).toEqual([]);
  });

  it("cannot be placed once the leg's transit is over", () => {
    const test = freightTestWorld();
    planCourse(test);
    advanceToStage(test.kernel, test.world, "approaching");
    expect(codeOf(schedule(test, debris))).toBe("preconditionFailed");
  });
});

describe("hazard invariants (D78)", () => {
  it("flag an unknown kind, an off-scale difficulty, a fractional tick and one overdue in transit", () => {
    const test = freightTestWorld();
    inTransit(test);
    const tick = test.world.state.tick;
    test.world.state.hazards = [
      { id: "h1" as never, kind: "blackHole" as HazardKind, difficulty: 5, fireAtTick: tick + 9 },
      { id: "h2" as never, kind: "ionStorm", difficulty: 11, fireAtTick: tick + 9 },
      { id: "h3" as never, kind: "ionStorm", difficulty: 3, fireAtTick: tick + 0.5 },
      { id: "h4" as never, kind: "ionStorm", difficulty: 3, fireAtTick: tick },
    ];
    expect(travelViolations(test.world)).toEqual([
      'hazard h1 has unknown kind "blackHole"',
      "hazard h2 difficulty 11 is not an integer in [1, 10]",
      `hazard h3 fireAtTick ${tick + 0.5} is not a whole tick`,
      `hazard h4 was due at tick ${tick} and has not fired in transit`,
    ]);
  });

  it("flag a hazard that outlived its leg's transit", () => {
    const test = freightTestWorld();
    planCourse(test);
    advanceToStage(test.kernel, test.world, "approaching");
    const tick = test.world.state.tick;
    test.world.state.hazards = [
      { id: "h1" as never, kind: "ionStorm", difficulty: 3, fireAtTick: tick + 9 },
    ];
    expect(travelViolations(test.world)).toEqual([
      "1 hazards outlived their leg's transit (stage approaching)",
    ]);
  });
});
