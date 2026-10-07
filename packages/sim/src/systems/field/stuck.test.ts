/**
 * D92: stuck is a clock, not a cliff (slice 5 call 9). A scripted knockout on the engine thirty
 * seconds in takes it from whole to out; the ship stops making way and is stuck in the rocks
 * (`shipStuck`), taking them at 70 % of the rate, and after six impacts while stuck it drifts
 * clear (`fieldCleared`, drifted). With the engine restored mid-field the ship is under way
 * again (`shipUnstuck`) and leaves by progress.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import {
  engineOf,
  fieldOf,
  fieldWorld,
  fieldWorldViolations,
  ofType,
  runUntil,
  scheduleField,
  secondsOf,
  underWay,
} from "./fixtures/field-deck";

/** A heavy field with the engine knocked out at 30 s; run until the ship is stuck. */
function knockedOutAtThirty(test: TestWorld) {
  underWay(test);
  const engine = engineOf(test.world);
  const field = scheduleField(test, {
    severity: "heavy",
    detection: "rolled",
    windowTicks: [0, 0],
    scripted: [
      {
        atSeconds: 30,
        target: { kind: "machine", machineId: engine.id },
        rock: "small",
        effect: "knockout",
      },
    ],
  });
  const events = runUntil(test, 60, () => {
    const phase = fieldOf(test.world).phase;
    return phase.kind === "active" && phase.stuckSinceTick !== undefined;
  });
  return { engine, field, events };
}

describe("stuck in the field (D92, call 9)", { timeout: 30_000 }, () => {
  it("a knocked-out engine leaves the ship stuck, and six impacts later it drifts clear", () => {
    const test = fieldWorld();
    const { engine, field, events } = knockedOutAtThirty(test);
    const phase = field.phase;
    if (phase.kind !== "active") throw new Error("not active");
    const knock = ofType(events, "machineKnockedOut");
    expect(knock.map((e) => [e.tick, e.payload.machineId])).toEqual([
      [phase.enteredTick + secondsOf(test.world, 30), engine.id],
    ]);
    expect(engine.integrity).toBe(0);
    expect(ofType(events, "shipStuck")).toHaveLength(1);
    const travel = test.world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    const progress = travel.routeProgress;
    const before = field.impacts;

    const rest = runUntil(test, 600, (w) => w.state.field?.phase.kind === "ended");
    expect(travel.routeProgress).toBe(progress);
    expect(field.stuckImpacts).toBe(6);
    expect(field.impacts).toBe(before + 6);
    const cleared = ofType(rest, "fieldCleared");
    expect(cleared.map((e) => e.payload.how)).toEqual(["drifted"]);
    expect(field.phase).toMatchObject({ kind: "ended", how: "drifted" });
    expect(test.world.state.alert?.clearsAtTick).toBeDefined();
    expect(fieldWorldViolations(test.world)).toEqual([]);
  });

  it("with the engine restored mid-field, the ship is under way again and leaves by progress", () => {
    const test = fieldWorld();
    const { engine, field } = knockedOutAtThirty(test);
    engine.integrity = 1;
    const events = runUntil(test, 300, (w) => w.state.field?.phase.kind === "ended");
    expect(ofType(events, "shipUnstuck")).toHaveLength(1);
    expect(ofType(events, "fieldCleared").map((e) => e.payload.how)).toEqual(["crossed"]);
    expect(field.phase).toMatchObject({ kind: "ended", how: "crossed" });
    expect(field.stuckImpacts).toBeLessThan(6);
  });
});
