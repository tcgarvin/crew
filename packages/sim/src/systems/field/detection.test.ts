/**
 * D92: detection and the alert (slice 5 call 4). The helm-stander's piloting check falls twelve
 * seconds before a `rolled` field: a pass sights it and raises the alert, and the first impact
 * that follows is only notable. With nobody at the helm, or an `unseen` field, nobody knows
 * until the first rock: that impact is a narrative `fieldEntered` and raises the alert. The alert
 * stands down `field.alertClearSeconds` after the field ends.
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { SimEvent } from "../../core/types/events";
import { fieldDifficulty } from "./detection";
import {
  fieldOf,
  fieldWorld,
  fieldWorldViolations,
  ofType,
  runUntil,
  secondsOf,
  underWay,
} from "./fixtures/field-deck";
import type { FieldPayload } from "./fixtures/field-deck";

/** Schedule `payload` and run to the field's end, with every event from the command on. */
function runField(test: TestWorld, payload: FieldPayload): SimEvent[] {
  test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "scheduleField", payload }),
  );
  return runUntil(test, 300, (w) => w.state.field?.phase.kind === "ended");
}

const light = (detection: FieldPayload["detection"]): FieldPayload => ({
  severity: "light",
  detection,
  windowTicks: [400, 400],
  scripted: [],
});

describe("detection and the alert (D92)", { timeout: 30_000 }, () => {
  it("checks a field at the nav-hazard difficulty of its severity", () => {
    const { world } = fieldWorld();
    const ctx = { config: world.config.values };
    expect(fieldDifficulty(ctx, "light")).toBe(3);
    expect(fieldDifficulty(ctx, "heavy")).toBe(5);
    expect(fieldDifficulty(ctx, "brutal")).toBe(7);
  });

  it("a piloting-9 stander sights a light field twelve seconds before it, and the ship goes on alert", () => {
    const test = fieldWorld({ piloting: 9 });
    underWay(test);
    const rock = {
      atSeconds: 5,
      target: { kind: "tile" as const, x: 5, y: 2 },
      rock: "small" as const,
    };
    const events = runField(test, { ...light("rolled"), scripted: [rock] });
    const field = fieldOf(test.world);
    const sighted = ofType(events, "fieldSighted");
    expect(sighted).toHaveLength(1);
    expect(sighted[0]?.payload.standerId).toBe("a1");
    expect(sighted[0]?.tick).toBe(field.startsAtTick - secondsOf(test.world, 12));
    expect(ofType(events, "alertRaised").map((e) => e.tick)).toEqual([sighted[0]?.tick]);
    expect(test.world.state.alert?.sinceTick).toBe(sighted[0]?.tick);
    expect(field.noticedAtTick).toBe(sighted[0]?.tick);
    // The first rock is no news to anyone: notable, no hook.
    const entered = ofType(events, "fieldEntered");
    expect(entered.map((e) => [e.payload.noticedBefore, e.significance])).toEqual([
      [true, "notable"],
    ]);
    expect(fieldWorldViolations(test.world)).toEqual([]);
  });

  it("with the helm empty, nobody sees it coming: the first impact is news and raises the alert", () => {
    const test = fieldWorld({ watch: false });
    underWay(test, false);
    const events = runField(test, { ...light("rolled"), severity: "heavy" });
    expect(ofType(events, "fieldSighted")).toEqual([]);
    const first = ofType(events, "asteroidImpact")[0];
    if (first === undefined) throw new Error("no impact in a heavy field with nobody at the helm");
    const entered = ofType(events, "fieldEntered");
    expect(entered.map((e) => [e.tick, e.payload.noticedBefore, e.significance])).toEqual([
      [first.tick, false, "narrative"],
    ]);
    expect(ofType(events, "alertRaised").map((e) => e.tick)).toEqual([first.tick]);
    expect(fieldOf(test.world).noticedAtTick).toBe(first.tick);
  });

  it("never sights an unseen field, whoever has the helm", () => {
    const test = fieldWorld({ piloting: 10 });
    underWay(test);
    const events = runField(test, { ...light("unseen"), severity: "heavy" });
    expect(ofType(events, "fieldSighted")).toEqual([]);
    expect(ofType(events, "fieldEntered")[0]?.payload.noticedBefore).toBe(false);
  });

  it("stands the alert down a minute after the field ends", () => {
    const test = fieldWorld({ piloting: 9 });
    underWay(test);
    runField(test, light("rolled"));
    const phase = fieldOf(test.world).phase;
    if (phase.kind !== "ended") throw new Error("field not ended");
    expect(test.world.state.alert?.clearsAtTick).toBe(phase.endedTick + secondsOf(test.world, 60));
    const events = runUntil(test, 70, (w) => w.state.alert === undefined);
    expect(ofType(events, "alertCleared").map((e) => e.tick)).toEqual([
      phase.endedTick + secondsOf(test.world, 60),
    ]);
  });
});
