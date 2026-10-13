import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import { cmd } from "../../core/fixtures/test-world";
import { TINY } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { shipHeadline } from "../../core/render";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, PortDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { ProblemOfKind } from "../../core/types/work";
import { ROUNDS_TILES, roundsWorld } from "../watch/fixtures/rounds-deck";
import { currentStep } from "../work/activity";
import { JON, MARA, crewWorld } from "../work/fixtures/crew-deck";
import { navTerminal } from "./course";
import { advanceThroughHooks } from "./fixtures";
import { registerTravel } from "./index";

function actorOf(world: World, id: ActorId) {
  const actor = world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

function setCourse(tw: TestWorld, to: PortDefId): void {
  tw.kernel.enqueueCommand(
    tw.world,
    cmd({ source: "scenario", kind: "setCourse", payload: { destinationPortId: to } }),
  );
}

/** Advance tick by tick (answering hooks), checking invariants, until `until` or `ticks` run out. */
function drive(tw: TestWorld, ticks: number, until?: (world: World) => boolean): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...advanceThroughHooks(tw.kernel, tw.world, 1).events);
    const violations = checkInvariants(tw.world.state);
    if (violations.length > 0) throw new Error(violations.join("; "));
    if (until?.(tw.world)) break;
  }
  return events;
}

const courseProblems = (world: World): ProblemOfKind<"courseToPlot">[] =>
  Object.values(world.state.work.problems).filter(
    (p): p is ProblemOfKind<"courseToPlot"> => p.kind === "courseToPlot",
  );

const openCourse = (world: World) => courseProblems(world).filter((p) => p.status === "open");

const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

const plotted = (events: readonly SimEvent[]) => ofType(events, "coursePlotted").length > 0;

/** Ticks of `plot` work until the course is plotted (the first tick that counted to the commit). */
function plotWorkTicks(tw: TestWorld): { ticks: number; events: SimEvent[] } {
  let first: number | undefined;
  const events: SimEvent[] = [];
  const seen = drive(tw, 20 * 120, (w) => {
    const step = currentStep(actorOf(w, MARA).activity);
    if (first === undefined && step?.kind === "work" && step.stage === "plot") first = w.state.tick;
    return w.state.travel.stage !== "docked";
  });
  events.push(...seen);
  const at = ofType(events, "coursePlotted")[0]?.tick;
  if (first === undefined || at === undefined) throw new Error("the course was never plotted");
  return { ticks: at - first + 1, events };
}

describe("course plotting (§course-plotting)", () => {
  it("a course set raises courseToPlot: one plotCourse task at the nav terminal for a qualified pilot", () => {
    const tw = roundsWorld({ travel: true });
    const { world } = tw;
    setCourse(tw, TINY.port2);
    drive(tw, 1);
    expect(world.state.travel).toEqual({
      stage: "docked",
      portId: TINY.port,
      plannedDestinationId: TINY.port2,
    });
    const [problem] = openCourse(world);
    expect(problem).toMatchObject({
      payload: { toPortId: TINY.port2 },
      owner: "travel",
      visibility: "public",
      baseUrgency: "essentialOperation",
    });
    // Derivation runs on the planner's cadence.
    drive(tw, world.config.values.work.reconsiderEveryTicks);
    const task = Object.values(world.state.work.tasks).find((t) => t.type === "plotCourse");
    expect(task).toMatchObject({
      problemId: problem?.id,
      target: { kind: "machine", machineId: navTerminal(world)?.id },
      requiredSkills: [{ skill: "piloting", min: 3 }],
      interactionTiles: [ROUNDS_TILES.navSeat],
      estimatedWorkSeconds: 20,
      workerSlots: 1,
    });
    expect(
      shipHeadline(world.state, world.content, { nominalSpeed: 1, limpSpeedFraction: 0 }),
    ).toBe("Preparing to depart for Far Dock — waiting on a course");
  });

  it("Mara plots it in plotCourseSeconds scaled by her piloting, and departure prep waits for it", () => {
    const tw = roundsWorld({ travel: true });
    setCourse(tw, TINY.port2);
    const { ticks, events } = plotWorkTicks(tw);
    // 20 s at 20 ticks/s, piloting 6 against the helm's 3: 1 + 0.1 × 3 per tick.
    expect(ticks).toBe(Math.ceil(400 / 1.3));
    const [plot] = ofType(events, "coursePlotted");
    expect(plot?.payload).toEqual({ toPortId: TINY.port2, actorId: MARA });
    expect(plot?.significance).toBe("notable");
    const prep = ofType(events, "travelStageChanged").find((e) => e.payload.from === "docked");
    expect(prep?.tick).toBe(plot?.tick);
    expect(courseProblems(tw.world).map((p) => p.status)).toEqual(["resolved"]);
    // Jon (piloting 0) never takes it.
    const plotTask = Object.values(tw.world.state.work.tasks).find((t) => t.type === "plotCourse");
    const claims = ofType(events, "taskClaimed").filter((e) => e.subjectIds[1] === plotTask?.id);
    expect(claims.every((e) => e.subjectIds[0] === MARA)).toBe(true);
    expect(claims.some((e) => e.subjectIds[0] === JON)).toBe(false);
  });

  it("a pilot at the helm's minimum plots at the base rate", () => {
    const tw = roundsWorld({ travel: true });
    actorOf(tw.world, MARA).skills = { ...actorOf(tw.world, MARA).skills, piloting: 3 };
    setCourse(tw, TINY.port2);
    expect(plotWorkTicks(tw).ticks).toBe(400);
  });

  it("with nobody qualified the ship waits, docked, on its course", () => {
    const tw = roundsWorld({ travel: true });
    actorOf(tw.world, MARA).skills = { ...actorOf(tw.world, MARA).skills, piloting: 2 };
    setCourse(tw, TINY.port2);
    const events = drive(tw, 20 * 60);
    expect(tw.world.state.travel.stage).toBe("docked");
    expect(plotted(events)).toBe(false);
    expect(openCourse(tw.world)).toHaveLength(1);
  });

  it("a voyage's next hop is plotted again at the waypoint", () => {
    const tw = roundsWorld({ travel: true });
    const { world } = tw;
    setCourse(tw, TINY.port3);
    const events = drive(tw, 20 * 200, (w) => {
      const travel = w.state.travel;
      return travel.stage === "preparingDeparture" && travel.fromPortId === TINY.port2;
    });
    expect(ofType(events, "coursePlotted").map((e) => e.payload.toPortId)).toEqual([
      TINY.port2,
      TINY.port3,
    ]);
    const arrived = ofType(events, "arrived").find((e) => e.payload.portId === TINY.port2);
    const second = courseProblems(world).find((p) => p.payload.toPortId === TINY.port3);
    expect(second?.createdTick).toBeGreaterThanOrEqual(arrived?.tick ?? Number.POSITIVE_INFINITY);
    const leaving = ofType(events, "travelStageChanged").filter((e) => e.payload.from === "docked");
    const secondPlot = ofType(events, "coursePlotted")[1];
    expect(leaving[1]?.tick).toBe(secondPlot?.tick);
  });

  it("a detour re-raises it for the new course, and the old one is cancelled", () => {
    const tw = roundsWorld({ travel: true });
    const { world } = tw;
    world.state.travel = { stage: "docked", portId: TINY.port2 };
    setCourse(tw, TINY.port);
    drive(tw, 2);
    expect(openCourse(world).map((p) => p.payload.toPortId)).toEqual([TINY.port]);
    setCourse(tw, TINY.port3);
    drive(tw, 2);
    expect(openCourse(world).map((p) => p.payload.toPortId)).toEqual([TINY.port3]);
    expect(courseProblems(world).find((p) => p.payload.toPortId === TINY.port)?.status).toBe(
      "cancelled",
    );
    const events = drive(tw, 20 * 60, () => false);
    expect(ofType(events, "coursePlotted").map((e) => e.payload.toPortId)).toEqual([TINY.port3]);
  });

  it("setting a course again after it was plotted clears the plot", () => {
    const tw = roundsWorld({ travel: true });
    const { world } = tw;
    // Plotted for Beyond, and the course is changed before the ship can leave on it.
    world.state.travel = {
      stage: "docked",
      portId: TINY.port2,
      plannedDestinationId: TINY.port3,
      coursePlotted: true,
    };
    setCourse(tw, TINY.port);
    drive(tw, 1);
    expect(world.state.travel).not.toHaveProperty("coursePlotted");
    expect(openCourse(world).map((p) => p.payload.toPortId)).toEqual([TINY.port]);
  });

  it("holding for repairs during prep keeps the plotted course: no second plot to leave again", () => {
    const tw = roundsWorld({ travel: true });
    const { world } = tw;
    setCourse(tw, TINY.port2);
    drive(tw, 20 * 60, (w) => w.state.travel.stage === "preparingDeparture");
    const helm = Object.values(world.state.machines).find((m) => m.placementKey === "helm1");
    if (helm === undefined) throw new Error("no helm");
    tw.kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "holdDepartureForRepairs", payload: { machineId: helm.id } }),
    );
    // Back to the dock on the same course; with nothing impaired the hold lifts at once.
    const events = drive(tw, 2);
    const stages = ofType(events, "travelStageChanged").map((e) => [e.payload.from, e.payload.to]);
    expect(stages).toEqual([
      ["preparingDeparture", "docked"],
      ["docked", "preparingDeparture"],
    ]);
    expect(plotted(events)).toBe(false);
    expect(courseProblems(world)).toHaveLength(1);
  });

  it("forgets a plot whose course was dropped", () => {
    const tw = roundsWorld({ travel: true });
    const { world } = tw;
    world.state.travel = { stage: "docked", portId: TINY.port, coursePlotted: true };
    drive(tw, 1);
    expect(world.state.travel).toEqual({ stage: "docked", portId: TINY.port });
  });

  it("a nav terminal down with a chart fault plots nothing; once repaired the course is plotted", () => {
    const tw = roundsWorld({ travel: true });
    const { world } = tw;
    const nav = navTerminal(world);
    const terminal = nav === undefined ? undefined : world.state.machines[nav.id];
    if (terminal === undefined) throw new Error("no nav terminal");
    terminal.faults.push({
      faultKey: "chart_fault",
      sinceTick: world.state.tick,
      diagnosed: false,
      repairStepIndex: 0,
      repairStepProgress: 0,
    });
    setCourse(tw, TINY.port2);
    let plotting = 0;
    const events = drive(tw, 20 * 60, (w) => {
      const step = currentStep(actorOf(w, MARA).activity);
      if (step?.kind === "work" && step.stage === "plot") plotting += 1;
      return false;
    });
    expect(plotting).toBe(0);
    expect(plotted(events)).toBe(false);
    expect(world.state.travel.stage).toBe("docked");
    expect(openCourse(world)).toHaveLength(1);
    terminal.faults = [];
    const after = drive(tw, 20 * 120, (w) => w.state.travel.stage !== "docked");
    expect(plotted(after)).toBe(true);
  });

  it("a ship with no nav terminal needs no plot: setCourse begins prep as before", () => {
    const tw = crewWorld({ extra: (registry) => registerTravel(registry) });
    expect(navTerminal(tw.world)).toBeUndefined();
    setCourse(tw, TINY.port2);
    drive(tw, 1);
    expect(tw.world.state.travel.stage).toBe("preparingDeparture");
    expect(courseProblems(tw.world)).toEqual([]);
  });
});
