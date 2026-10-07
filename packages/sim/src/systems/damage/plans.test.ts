/**
 * Damage work carried out (slice 5 calls 10, 21, 22) on the damage fixture, headless with the
 * planner: the engineer fetches the welder and mends a damaged workbench to whole; patches a scar
 * for half its damage with a kit from a locker, the hull bar rising by that; patches nothing when
 * the ship has no kits.
 */
import { describe, expect, it } from "vitest";
import type { World } from "../../core/types/kernel";
import {
  TOMAS,
  loungeStepCtx,
  ofType,
  placeInLounge,
  runFor,
  runUntil,
} from "../recreation/fixtures/lounge-deck";
import { carriedItems } from "../work/plans";
import {
  BENCH_SEAT,
  DAMAGE,
  LOUNGE_FLOOR,
  damageWorld,
  machineAt,
  soundAlert,
  strike,
} from "./fixtures/damage-deck";
import { damageMachine } from "./machines";

const LONG = { timeout: 30_000 };

function settled(options: Parameters<typeof damageWorld>[0] = {}) {
  const fixture = damageWorld(options);
  runFor(fixture, 1);
  return fixture;
}

const kitsAboard = (world: World): number =>
  Object.values(world.state.items)
    .filter((item) => item.defId === DAMAGE.kit)
    .reduce((sum, item) => sum + (item.stacking === "stack" ? item.count : 1), 0);

describe("repairDamage (call 21)", () => {
  it("the engineer fetches the welder and mends a damaged workbench to whole", LONG, () => {
    const fixture = settled();
    const { world } = fixture;
    placeInLounge(world, TOMAS, BENCH_SEAT);
    const bench = world.state.machines[machineAt(world, "workbench")];
    if (bench === undefined) throw new Error("no workbench");
    damageMachine(loungeStepCtx(world).ctx, bench, 0.5);
    const events = runUntil(fixture, 60, (_w, seen) => ofType(seen, "machineMended").length > 0);
    expect(ofType(events, "machineMended")[0]?.payload).toEqual({
      actorId: TOMAS,
      machineId: bench.id,
    });
    expect(bench.integrity).toBe(1);
    const problem = Object.values(world.state.work.problems).find(
      (p) => p.kind === "machineDamaged",
    );
    expect(problem?.status).toBe("resolved");
    // The welder is set down where the work ended, for the next job (D69).
    runFor(fixture, 1);
    expect(carriedItems(world, TOMAS).some((item) => item.defId === DAMAGE.welder)).toBe(false);
  });
});

describe("patchHull (calls 10, 22)", () => {
  it("patches a scar for half with a kit from a locker; the hull bar rises by that", LONG, () => {
    const fixture = settled();
    const { world } = fixture;
    placeInLounge(world, TOMAS, LOUNGE_FLOOR);
    soundAlert(world);
    const hit = strike(world, LOUNGE_FLOOR, 8);
    expect(world.state.hull.integrity).toBe(92);
    const before = kitsAboard(world);
    const events = runUntil(fixture, 90, (_w, seen) => ofType(seen, "hullPatched").length > 0);
    expect(ofType(events, "hullPatched")[0]?.payload).toEqual({
      actorId: TOMAS,
      scarId: hit.scarId,
      compartmentId: hit.compartmentId,
      recovered: 4,
    });
    expect(world.state.hull.integrity).toBe(96);
    expect(world.state.hull.scars[0]).toMatchObject({ patched: true, recovered: 4 });
    expect(kitsAboard(world)).toBe(before - 1);
    // The scar stays open for its plate at port; no second patch is derived.
    const scarProblem = Object.values(world.state.work.problems).find((p) => p.kind === "hullScar");
    expect(scarProblem?.status).toBe("open");
    const more = runFor(fixture, 30);
    expect(ofType(more, "hullPatched")).toHaveLength(0);
  });

  it("a ship with no kits aboard patches nothing", LONG, () => {
    const fixture = settled({ kits: false });
    const { world } = fixture;
    placeInLounge(world, TOMAS, LOUNGE_FLOOR);
    soundAlert(world);
    strike(world, LOUNGE_FLOOR, 8);
    const events = runFor(fixture, 60);
    expect(ofType(events, "hullPatched")).toHaveLength(0);
    expect(Object.values(world.state.work.tasks).some((t) => t.type === "patchHull")).toBe(false);
    expect(world.state.hull.integrity).toBe(92);
  });
});
