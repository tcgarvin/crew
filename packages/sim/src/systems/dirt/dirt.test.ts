/** The dirt pass (D82): tiers and their events, and the `compartmentDirty` problem's life. */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { TileCoord } from "../../core/types/common";
import type { SimEvent } from "../../core/types/events";
import type { ProblemOfKind } from "../../core/types/work";
import { stepChecked } from "../spatial/fixtures/helpers";
import { dirtWorld, soil } from "./fixtures/dirt-deck";
import { dirtViolations } from "./invariants";

const rect = (x0: number, x1: number, y0: number, y1: number): TileCoord[] =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) =>
    Array.from({ length: y1 - y0 + 1 }, (_, j) => ({ x: x0 + i, y: y0 + j })),
  ).flat();

const GALLEY = rect(4, 7, 0, 4);
const HOLD = rect(0, 11, 5, 6);

/** Soil a room evenly to `share` of 1.0 and run a second of dirt passes; return the events. */
function soilAndStep(test: TestWorld, tiles: readonly TileCoord[], share: number): SimEvent[] {
  soil(test, tiles, Math.round(share * 255));
  return stepChecked(test, 20, () => {
    const violations = dirtViolations(test.world);
    if (violations.length > 0) throw new Error(violations.join("; "));
  });
}

const roomEvents = (events: readonly SimEvent[]) =>
  events
    .filter((e) => ["roomDirty", "roomFilthy", "roomTidied", "roomCleaned"].includes(e.type))
    .map((e) => e.type);

function dirtProblems(test: TestWorld): ProblemOfKind<"compartmentDirty">[] {
  return Object.values(test.world.state.work.problems).filter(
    (p): p is ProblemOfKind<"compartmentDirty"> => p.kind === "compartmentDirty",
  );
}

describe("tiers (D82)", () => {
  it("rise at the thresholds and fall with hysteresis, one event per transition", () => {
    const test = dirtWorld({ bare: true });
    const tiers = () => test.world.state.dirt.tiers.roomB;
    expect(roomEvents(soilAndStep(test, GALLEY, 0.15))).toEqual([]);
    expect(tiers()).toBe("untidy");
    expect(roomEvents(soilAndStep(test, GALLEY, 0.35))).toEqual(["roomDirty"]);
    expect(tiers()).toBe("dirty");
    expect(roomEvents(soilAndStep(test, GALLEY, 0.35))).toEqual([]);
    expect(roomEvents(soilAndStep(test, GALLEY, 0.6))).toEqual(["roomFilthy"]);
    // Just under `filthy` but within the hysteresis: still filthy.
    expect(roomEvents(soilAndStep(test, GALLEY, 0.52))).toEqual([]);
    expect(tiers()).toBe("filthy");
    expect(roomEvents(soilAndStep(test, GALLEY, 0.45))).toEqual([]);
    expect(tiers()).toBe("dirty");
    expect(roomEvents(soilAndStep(test, GALLEY, 0.2))).toEqual(["roomTidied"]);
    expect(tiers()).toBe("untidy");
    expect(roomEvents(soilAndStep(test, GALLEY, 0))).toEqual([]);
    expect(tiers()).toBe("clean");
    // Clean to filthy at once is one transition and one event.
    expect(roomEvents(soilAndStep(test, GALLEY, 0.9))).toEqual(["roomFilthy"]);
  });
});

describe("compartmentDirty (D82)", () => {
  it("opens at dirty as routine, turns essential for a filthy galley, resolves once clean", () => {
    const test = dirtWorld({ bare: true });
    soilAndStep(test, GALLEY, 0.2);
    expect(dirtProblems(test)).toEqual([]);
    const raised = soilAndStep(test, GALLEY, 0.35);
    const [problem] = dirtProblems(test);
    expect(problem).toMatchObject({
      owner: "dirt",
      visibility: "public",
      dedupeKey: "dirty:roomB",
      status: "open",
      baseUrgency: "routineObligation",
      payload: { key: "roomB", tier: "dirty" },
    });
    expect(raised.filter((e) => e.type === "problemRaised")).toHaveLength(1);
    const revision = problem?.revision ?? 0;
    soilAndStep(test, GALLEY, 0.6);
    expect(problem).toMatchObject({
      baseUrgency: "essentialOperation",
      payload: { tier: "filthy" },
    });
    expect(problem?.revision).toBe(revision + 1);
    soilAndStep(test, GALLEY, 0.45);
    expect(problem).toMatchObject({ baseUrgency: "routineObligation", payload: { tier: "dirty" } });
    // Untidy is not clean: still open.
    soilAndStep(test, GALLEY, 0.2);
    expect(problem?.status).toBe("open");
    const cleaned = soilAndStep(test, GALLEY, 0);
    expect(problem?.status).toBe("resolved");
    // Nobody held its task: resolved without a `roomCleaned`.
    expect(roomEvents(cleaned)).toEqual([]);
    expect(cleaned.filter((e) => e.type === "problemResolved")).toHaveLength(1);
    expect(dirtProblems(test)).toHaveLength(1);
  });

  it("a filthy hold stays routine (only a galley or infirmary is essential)", () => {
    const test = dirtWorld({ bare: true });
    soilAndStep(test, HOLD, 0.8);
    expect(dirtProblems(test)).toMatchObject([
      { baseUrgency: "routineObligation", payload: { key: "hall", tier: "filthy" } },
    ]);
  });
});
