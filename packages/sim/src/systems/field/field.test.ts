/**
 * §field-lifecycle: the field's life (slice 5 calls 3 and 19). A field scheduled in port waits for
 * transit, with the helm's check on the first transit tick and the rocks from its start; it spans
 * the severity's length of route from where the ship enters it, never past the approach lead; it
 * ends when progress leaves it (`fieldCleared`, crossed) and stays, ended, until the leg ends,
 * so the leg takes no second one; a field due past the approach lead never begins.
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { advanceToStage } from "../travel/fixtures";
import {
  LEG_DISTANCE,
  fieldOf,
  fieldWorld,
  fieldWorldViolations,
  ofType,
  runUntil,
  scheduleField,
  secondsOf,
  setPlottedCourse,
  underWay,
} from "./fixtures/field-deck";

describe("the field's lifecycle (§field-lifecycle)", { timeout: 30_000 }, () => {
  it("scheduled in port, waits for transit: the helm's check on the first transit tick, the rocks from its start", () => {
    const test = fieldWorld();
    setPlottedCourse(test);
    const field = scheduleField(test, {
      severity: "light",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [],
    });
    const events = runUntil(test, 300, (w) => w.state.travel.stage === "transit");
    expect(field.phase.kind).toBe("scheduled");
    const firstTransitTick = test.world.state.tick;
    // Held while the ship left port: the check fell on this tick, the start a warning later.
    expect(field.startsAtTick).toBe(firstTransitTick + secondsOf(test.world, 12));
    expect(ofType(events, "fieldSighted").map((e) => e.tick)).toEqual([firstTransitTick]);
    expect(field.noticedAtTick).toBe(firstTransitTick);
    runUntil(test, 30, (w) => w.state.field?.phase.kind === "active");
    const phase = fieldOf(test.world).phase;
    expect(phase.kind === "active" && phase.enteredTick).toBe(field.startsAtTick);
    expect(fieldWorldViolations(test.world)).toEqual([]);
  });

  it("spans the severity's length of route from where it is entered, and is crossed when progress leaves it", () => {
    const test = fieldWorld();
    underWay(test);
    const field = scheduleField(test, {
      severity: "heavy",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [],
    });
    runUntil(test, 30, (w) => w.state.field?.phase.kind === "active");
    const travel = test.world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    const phase = field.phase;
    if (phase.kind !== "active") throw new Error("not active");
    // 135 s at nominal speed 5, from the progress at entry (this tick's travel already ran).
    expect(phase.endsAtProgress).toBeCloseTo(travel.routeProgress + 135 * 5, 6);
    const events = runUntil(test, 200, (w) => w.state.field?.phase.kind === "ended");
    const cleared = ofType(events, "fieldCleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.payload).toMatchObject({
      how: "crossed",
      impacts: field.impacts,
      hullLost: field.hullLost,
      integrity: test.world.state.hull.integrity,
      max: 100,
    });
    expect(test.world.state.hull.integrity).toBe(100 - field.hullLost);
    expect(fieldWorldViolations(test.world)).toEqual([]);
  });

  it("holds the leg's one field once ended, and goes with the leg", () => {
    const test = fieldWorld();
    underWay(test);
    scheduleField(test, {
      severity: "light",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [],
    });
    runUntil(test, 200, (w) => w.state.field?.phase.kind === "ended");
    const again = test.kernel.enqueueCommand(
      test.world,
      cmd({
        source: "scenario",
        kind: "scheduleField",
        payload: { severity: "light", detection: "rolled", windowTicks: [0, 0], scripted: [] },
      }),
    );
    expect(again.status === "rejected" && again.rejection.reason).toContain("one per leg");
    const travel = test.world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    travel.routeProgress = LEG_DISTANCE - 1;
    advanceToStage(test.kernel, test.world, "approaching");
    expect(test.world.state.field).toBeUndefined();
  });

  it("ends at the approach lead at the latest, so the ship is out before travel holds for the staging call", () => {
    const test = fieldWorld();
    underWay(test);
    const travel = test.world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    travel.routeProgress = LEG_DISTANCE - 100;
    scheduleField(test, {
      severity: "heavy",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [],
    });
    runUntil(test, 30, (w) => w.state.field?.phase.kind === "active");
    const phase = fieldOf(test.world).phase;
    // The lead is 1 s at nominal speed 5.
    expect(phase.kind === "active" && phase.endsAtProgress).toBe(LEG_DISTANCE - 5);
    const events = runUntil(test, 60, (w) => w.state.field?.phase.kind === "ended");
    expect(ofType(events, "fieldCleared")[0]?.payload.how).toBe("crossed");
  });

  it("never begins when it falls due past the approach lead: missed", () => {
    const test = fieldWorld();
    underWay(test);
    const travel = test.world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    travel.routeProgress = LEG_DISTANCE - 60;
    scheduleField(test, {
      severity: "light",
      detection: "unseen",
      windowTicks: [0, 0],
      scripted: [],
    });
    const events = runUntil(test, 30, (w) => w.state.field === undefined);
    expect(ofType(events, "fieldMissed")).toHaveLength(1);
    expect(ofType(events, "asteroidImpact")).toEqual([]);
  });
});
