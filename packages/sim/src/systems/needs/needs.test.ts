import { describe, expect, it } from "vitest";
import { JON, MARA, crewWorld, place } from "../work/fixtures/crew-deck";
import { eventsOf, run } from "../work/fixtures/run";
import { fatigueCapacity } from "./needs";

describe("needs", () => {
  it("rise at the configured per-day rates, converted to per second, while awake and idle", () => {
    const tw = crewWorld();
    const { world } = tw;
    const jon = world.state.actors[JON];
    if (jon === undefined) throw new Error("no jon");
    jon.availability = "incapacitated";
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no mara");
    run(tw, 20 * 10);
    const c = world.config.values.needs;
    const tenSecondsInDays = 10 / world.config.values.time.daySeconds;
    expect(mara.needs.hunger).toBeCloseTo(c.hungerPerDay * tenSecondsInDays, 6);
    expect(mara.needs.fatigue).toBeCloseTo(c.fatiguePerDayAwake * tenSecondsInDays, 6);
    expect(mara.needs.comfort).toBeCloseTo(c.comfortPerDay * tenSecondsInDays, 6);
    expect(mara.needs.social).toBeCloseTo(c.socialPerDay * tenSecondsInDays, 6);
    // The fixture's 600 s day: 0.6 per day is the 0.001 per second the test was written for.
    expect(mara.needs.hunger).toBeCloseTo(0.01, 6);
  });

  it("emits a notable threshold event when a need goes critical", () => {
    const tw = crewWorld();
    const { world } = tw;
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no mara");
    place(world, MARA, { x: 0, y: 6 });
    mara.needs.hunger = world.config.values.urgency.needSurvivalAbove - 0.0005;
    const log = run(tw, 20);
    const critical = eventsOf(log, "needThresholdCrossed").filter(
      (e) => e.payload.need === "hunger" && e.significance === "notable",
    );
    expect(critical).toHaveLength(1);
    expect(critical[0]?.payload.rising).toBe(true);
  });

  it("severe fatigue impairs movement and manipulation within bounds", () => {
    expect(fatigueCapacity(0.5, 0.9, 0.5)).toBe(1);
    expect(fatigueCapacity(0.95, 0.9, 0.5)).toBeCloseTo(0.75);
    expect(fatigueCapacity(1, 0.9, 0.5)).toBeCloseTo(0.5);
    expect(fatigueCapacity(2, 0.9, -1)).toBe(0);
    const tw = crewWorld();
    const mara = tw.world.state.actors[MARA];
    if (mara === undefined) throw new Error("no mara");
    mara.needs.fatigue = 0.99;
    run(tw, 1);
    expect(mara.capacities.movement).toBeLessThan(1);
    expect(mara.capacities.movement).toBeGreaterThanOrEqual(
      tw.world.config.values.movement.fatigueSpeedFloor,
    );
    expect(mara.capacities.manipulation).toBe(mara.capacities.movement);
  });
});
