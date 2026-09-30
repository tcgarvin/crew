import { describe, expect, it } from "vitest";
import { TINY } from "../../core/fixtures/tiny-content";
import type { StackItem } from "../../core/types/ship";
import { requestMove } from "../spatial/movement";
import {
  JON,
  MARA,
  STOWAGE_TILES,
  addCrateToLoad,
  addEngineFault,
  addPumpSymptom,
  crewWorld,
  itemAt,
  place,
} from "./fixtures/crew-deck";
import { eventsOf, run } from "./fixtures/run";

const inStowage = (x: number, y: number) =>
  STOWAGE_TILES.some((t) => t.x === Math.floor(x) && t.y === Math.floor(y));

describe("hauling", () => {
  it("derives one task, the nearest actor claims it, the crate ends in the zone and the problem closes", () => {
    const tw = crewWorld();
    const { world } = tw;
    place(world, MARA, { x: 2, y: 6 });
    place(world, JON, { x: 11, y: 5 });
    const { itemId, problemId } = addCrateToLoad(world, { x: 3, y: 6 });

    // Several derivation passes: still exactly one task for the problem.
    run(tw, 35);
    const tasks = Object.values(world.state.work.tasks).filter((t) => t.problemId === problemId);
    expect(tasks).toHaveLength(1);
    const taskId = tasks[0]?.id;

    const log = run(tw, 20 * 60, () => world.state.work.problems[problemId]?.status === "resolved");
    const crate = world.state.items[itemId];
    expect(crate?.location.kind).toBe("onDeck");
    if (crate?.location.kind === "onDeck")
      expect(inStowage(crate.location.x, crate.location.y)).toBe(true);
    expect(world.state.work.problems[problemId]?.status).toBe("resolved");
    const claims = [...eventsOf(log, "taskClaimed")].filter((e) => e.payload.taskId === taskId);
    expect(claims.every((e) => e.subjectIds[0] === MARA)).toBe(true);
    expect(eventsOf(log, "taskCompleted").some((e) => e.payload.taskId === taskId)).toBe(true);
    expect(log.labels[MARA]).toContain("hauling crate");
    expect(Object.keys(world.state.work.claims)).toHaveLength(0);
  });

  it("does not let a second actor steal a claimed haul", () => {
    const tw = crewWorld();
    const { world } = tw;
    place(world, MARA, { x: 1, y: 6 });
    place(world, JON, { x: 5, y: 6 });
    const { problemId } = addCrateToLoad(world, { x: 3, y: 5 });
    const log = run(tw, 20 * 60, () => world.state.work.problems[problemId]?.status === "resolved");
    const claimants = new Set(eventsOf(log, "taskClaimed").map((e) => e.subjectIds[0]));
    expect(claimants.size).toBe(1);
    expect(world.state.work.problems[problemId]?.status).toBe("resolved");
  });
});

describe("inspecting", () => {
  it("the higher-engineering actor takes the inspection; labels go walking → inspecting", () => {
    const tw = crewWorld();
    const { world } = tw;
    place(world, MARA, { x: 8, y: 2 });
    place(world, JON, { x: 8, y: 3 });
    const { problemId } = addPumpSymptom(world);
    const log = run(tw, 20 * 60, () => world.state.work.problems[problemId]?.status === "resolved");
    expect(world.state.work.problems[problemId]?.status).toBe("resolved");
    const claimed = eventsOf(log, "taskClaimed").map((e) => e.subjectIds[0]);
    expect(claimed[0]).toBe(JON);
    const labels = log.labels[JON] ?? [];
    const walking = labels.findIndex((l) => l.startsWith("walking to"));
    const inspecting = labels.indexOf("inspecting coolant pump");
    expect(walking).toBeGreaterThanOrEqual(0);
    expect(inspecting).toBeGreaterThan(walking);
    expect(eventsOf(log, "faultDiagnosed")).toHaveLength(1);
  });

  it("a discovered symptom is invisible from another room until the actor walks in", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    place(world, MARA, { x: 1, y: 2 });
    place(world, JON, { x: 0, y: 6 });
    const jon = world.state.actors[JON];
    if (jon === undefined) throw new Error("no jon");
    jon.availability = "incapacitated";
    const { problemId } = addPumpSymptom(world);
    run(tw, 40);
    expect(
      kernel
        .getAgentView(world, MARA)
        .knownProblems()
        .map((p) => p.id),
    ).not.toContain(problemId);
    expect(world.state.actors[MARA]?.activity.kind).toBe("idle");

    expect(requestMove(world.state, MARA, { x: 8, y: 3 }, world.caches, world.config.values)).toBe(
      true,
    );
    const walk = run(tw, 20 * 20, (w) => w.state.actors[MARA]?.activity.kind === "task");
    const roomC = Object.values(world.state.compartments).find((c) => c.key === "roomC")?.id;
    const entered = eventsOf(walk, "enteredCompartment").find(
      (e) => e.subjectIds[0] === MARA && e.payload.compartmentId === roomC,
    );
    const observed = eventsOf(walk, "problemObserved")[0];
    expect(entered).toBeDefined();
    expect(observed?.payload.problemId).toBe(problemId);
    expect(observed?.subjectIds[0]).toBe(MARA);
    const lag = (observed?.tick ?? Number.POSITIVE_INFINITY) - (entered?.tick ?? 0);
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThanOrEqual(10);
    expect(
      kernel
        .getAgentView(world, MARA)
        .knownProblems()
        .map((p) => p.id),
    ).toContain(problemId);
    const selected = eventsOf(walk, "taskSelected")[0];
    expect(selected).toBeDefined();
    expect(world.state.work.tasks[selected?.payload.taskId as never]?.type).toBe("inspect");
    expect((selected?.tick ?? 0) - (observed?.tick ?? 0)).toBeLessThanOrEqual(20);
  });
});

describe("interruption", () => {
  it("a containment task interrupts a routine haul; the crate is dropped where the hauler stands", () => {
    const tw = crewWorld();
    const { world } = tw;
    const jon = world.state.actors[JON];
    const mara = world.state.actors[MARA];
    if (jon === undefined || mara === undefined) throw new Error("no crew");
    jon.availability = "incapacitated";
    place(world, MARA, { x: 0, y: 6 });
    const { itemId, problemId } = addCrateToLoad(world, { x: 1, y: 6 });
    const hauling = run(tw, 20 * 30, (w) => {
      const loc = w.state.items[itemId]?.location;
      const m = w.state.actors[MARA];
      return loc?.kind === "carriedBy" && m?.location.kind === "onDeck" && m.location.x > 4;
    });
    expect(hauling.labels[MARA]).toContain("hauling crate");
    const haulTaskId = Object.values(world.state.work.tasks).find(
      (t) => t.problemId === problemId,
    )?.id;

    addEngineFault(world);
    const log = run(tw, 20 * 5, (w) => w.state.items[itemId]?.location.kind === "onDeck");
    const crate = world.state.items[itemId];
    expect(crate?.location.kind).toBe("onDeck");
    if (crate?.location.kind === "onDeck" && mara.location.kind === "onDeck") {
      expect(Math.abs(crate.location.x - mara.location.x)).toBeLessThan(1e-9);
      expect(Math.abs(crate.location.y - mara.location.y)).toBeLessThan(1e-9);
      expect(inStowage(crate.location.x, crate.location.y)).toBe(false);
      expect(crate.location.x).toBeGreaterThan(4);
    }
    const released = eventsOf(log, "taskReleased").find((e) => e.payload.taskId === haulTaskId);
    expect(released?.payload.reason).toBe("interrupted");
    expect(mara.activity.kind === "task" && mara.activity.urgency).toBe("containment");

    const after = run(tw, 20 * 30);
    expect(after.labels[MARA]).toContain("fixing engine");
  });
});

describe("discrepancies", () => {
  it("a moved ration stack is noted absent, the meal fails with a reason, backoff is honoured, and eating resumes once found", () => {
    const tw = crewWorld();
    const { world } = tw;
    const mara = world.state.actors[MARA];
    const jon = world.state.actors[JON];
    if (mara === undefined || jon === undefined) throw new Error("no crew");
    jon.availability = "incapacitated";
    place(world, MARA, { x: 1, y: 5 });
    mara.needs.hunger = 0.6;
    const stackId = itemAt(world, TINY.rations);
    const stack = world.state.items[stackId] as StackItem;

    run(tw, 30, () => mara.activity.kind === "personal");
    expect(mara.activity.kind).toBe("personal");
    // Someone moves the rations to the quarters after she set off.
    stack.location = {
      kind: "onDeck",
      deckId: stack.location.kind === "onDeck" ? stack.location.deckId : ("" as never),
      x: 0.5,
      y: 2.5,
    };
    world.caches.dirty.inventory = true;

    const failing = run(tw, 20 * 30, () => mara.activity.kind === "idle");
    const failed = eventsOf(failing, "actionFailed")[0];
    expect(failed?.payload.reason).toBe("inaccessibleSupply");
    const fact = mara.knowledge[`${stackId}/itemLocation`];
    expect(fact?.factType === "itemLocation" && fact.value.absent).toBe(true);
    const retryAfter = mara.workBackoff?.[`eat:${stackId}`];
    expect(retryAfter).toBeGreaterThan(world.state.tick);

    // Found again: put the stack back on the galley floor next to her.
    const here = mara.location;
    if (here.kind !== "onDeck") throw new Error("off deck");
    stack.location = {
      kind: "onDeck",
      deckId: here.deckId,
      x: Math.floor(here.x) + 0.5,
      y: Math.floor(here.y) + 0.5,
    };
    world.caches.dirty.inventory = true;
    const resumed = run(tw, 20 * 40, () => mara.needs.hunger < 0.4);
    const restart = resumed.events.find(
      (e) => e.type === "personalActivityStarted" && e.subjectIds[0] === MARA,
    );
    expect(restart).toBeDefined();
    expect(restart?.tick).toBeGreaterThanOrEqual(retryAfter ?? 0);
    expect(eventsOf(resumed, "ateMeal")).toHaveLength(1);
  });
});
