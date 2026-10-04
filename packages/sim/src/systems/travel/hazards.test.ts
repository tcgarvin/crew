import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import type { HazardKind } from "../../core/types/content";
import { PORTS, freightTestWorld } from "./fixtures";

type Payload = { kind: HazardKind; difficulty: number; windowTicks: readonly [number, number] };

function schedule(test: ReturnType<typeof freightTestWorld>, payload: Payload) {
  return test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "scheduleHazard", payload }),
  );
}

const codeOf = (result: ReturnType<typeof schedule>) =>
  result.status === "rejected" ? result.rejection.code : result.status;

/** A planned course: `setCourse` while docked (applied at the next tick). */
function planCourse(test: ReturnType<typeof freightTestWorld>) {
  test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
  );
  test.kernel.advance(test.world, 1);
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
});
