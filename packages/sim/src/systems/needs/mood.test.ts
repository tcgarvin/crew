import { describe, expect, it } from "vitest";
import { JON, MARA, crewWorld } from "../work/fixtures/crew-deck";
import { run } from "../work/fixtures/run";
import { needsViolations } from "./invariants";

function world() {
  const tw = crewWorld();
  const mara = tw.world.state.actors[MARA];
  const jon = tw.world.state.actors[JON];
  if (mara === undefined || jon === undefined) throw new Error("fixture crew missing");
  return { tw, mara, jon };
}

describe("moodSystem (D79)", () => {
  it("lets thoughts wear off: drops the expired ones and recomputes mood from the rest", () => {
    const { tw, mara } = world();
    const now = tw.world.state.tick;
    mara.thoughts = [
      { key: "helmScrape", value: -0.3, expiresAtTick: now + 5 },
      { key: "helmCleanPass", value: 0.1, expiresAtTick: now + 50 },
    ];
    run(tw, 1);
    expect(mara.mood).toBeCloseTo(-0.2);
    run(tw, 5);
    expect(mara.thoughts.map((t) => t.key)).toEqual(["helmCleanPass"]);
    expect(mara.mood).toBeCloseTo(0.1);
    run(tw, 50);
    expect(mara.thoughts).toEqual([]);
    expect(mara.mood).toBe(0);
    expect(needsViolations(tw.world)).toEqual([]);
  });

  it("is what the needs invariants check: mood in [-1, 1] and equal to the live thoughts' sum", () => {
    const { tw, mara, jon } = world();
    mara.mood = 0.5;
    jon.mood = Number.NaN;
    expect(needsViolations(tw.world)).toEqual([
      `actors.${MARA}.mood 0.5 is not its thoughts' 0`,
      `actors.${JON}.mood NaN is outside [-1, 1]`,
    ]);
    run(tw, 1);
    expect(needsViolations(tw.world)).toEqual([]);
  });
});
