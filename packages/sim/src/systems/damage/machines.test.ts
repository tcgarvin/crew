/**
 * The two points where the field calls into damage response (slice 5 calls 4, 10, 11, 21), on the
 * damage fixture with rocks thrown by hand: `damageMachine` lowers integrity and raises or revises
 * `machineDamaged`; `onImpact` raises the scar's problem at the alert's urgency, is felt by
 * everyone aboard and placed only by those in the room, wakes a sleeper there, and lets whoever is
 * in the room see the scar at once.
 */
import { describe, expect, it } from "vitest";
import type { ActorId, LocalKey } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { ProblemOfKind } from "../../core/types/work";
import {
  BETTINA,
  BUNKROOM_FLOOR,
  DANE,
  JAX,
  MARA,
  NOOR,
  TOMAS,
  loungeStepCtx,
  placeInLounge,
  runFor,
  runUntil,
  setNeed,
} from "../recreation/fixtures/lounge-deck";
import { isAsleep } from "../work/activity";
import {
  BENCH_SEAT,
  LOUNGE_FLOOR,
  damageWorld,
  machineAt,
  room,
  soundAlert,
  strike,
} from "./fixtures/damage-deck";
import { damageMachine } from "./machines";

const LONG = { timeout: 30_000 };

function problemsOf<K extends "machineDamaged" | "hullScar">(world: World, kind: K) {
  return Object.values(world.state.work.problems).filter(
    (p): p is ProblemOfKind<K> => p.kind === kind,
  );
}

/** A world a second in, so everyone has had the first look that briefs them on the ship. */
function settled() {
  const fixture = damageWorld();
  runFor(fixture, 1);
  return fixture;
}

describe("damageMachine (call 21)", () => {
  it("takes integrity off, clamped at zero, and raises machineDamaged at the machine", () => {
    const { world } = settled();
    const bench = world.state.machines[machineAt(world, "workbench")];
    if (bench === undefined) throw new Error("no workbench");
    const { ctx } = loungeStepCtx(world);
    damageMachine(ctx, bench, 0.5);
    expect(bench.integrity).toBeCloseTo(0.5);
    const [problem] = problemsOf(world, "machineDamaged");
    expect(problem).toMatchObject({
      owner: "damage",
      visibility: "discovered",
      baseUrgency: "essentialOperation",
      dedupeKey: `machineDamaged:${bench.id}`,
      location: { kind: "machine", machineId: bench.id },
      payload: { machineId: bench.id },
      status: "open",
    });
    const revision = problem?.revision ?? 0;
    damageMachine(ctx, bench, 0.8);
    expect(bench.integrity).toBe(0);
    expect(problemsOf(world, "machineDamaged")).toHaveLength(1);
    expect(problem?.revision).toBe(revision + 1);
  });

  it("raises nothing for a glancing blow that leaves the machine whole, and refuses a negative loss", () => {
    const { world } = settled();
    const bench = world.state.machines[machineAt(world, "workbench")];
    if (bench === undefined) throw new Error("no workbench");
    const { ctx } = loungeStepCtx(world);
    damageMachine(ctx, bench, 0);
    expect(problemsOf(world, "machineDamaged")).toHaveLength(0);
    expect(() => damageMachine(ctx, bench, -0.1)).toThrow(/>= 0/);
  });
});

describe("onImpact (calls 4, 10, 11)", () => {
  it("raises the scar's problem in its room: essential on alert, routine otherwise", () => {
    const { world } = settled();
    const quiet = strike(world, LOUNGE_FLOOR);
    soundAlert(world);
    const loud = strike(world, BENCH_SEAT);
    const scars = problemsOf(world, "hullScar");
    expect(scars.map((p) => p.payload.scarId)).toEqual([quiet.scarId, loud.scarId]);
    expect(scars[0]).toMatchObject({
      owner: "damage",
      visibility: "discovered",
      baseUrgency: "routineObligation",
      location: { kind: "compartment", compartmentId: room(world, "lounge") },
      payload: { compartmentId: room(world, "lounge"), tile: LOUNGE_FLOOR },
    });
    expect(scars[1]?.baseUrgency).toBe("essentialOperation");
    expect(scars[1]?.location).toEqual({ kind: "compartment", compartmentId: room(world, "gym") });
  });

  it("is felt by everyone aboard and placed only by those in the hit room", () => {
    const { world } = settled();
    placeInLounge(world, BETTINA, LOUNGE_FLOOR);
    placeInLounge(world, TOMAS, { x: 10, y: 2 });
    const hit = strike(world, { x: 5, y: 4 });
    const fieldId = world.state.field?.id;
    if (fieldId === undefined) throw new Error("no field");
    const impactOf = (id: ActorId) => world.state.actors[id]?.knowledge[`${fieldId}/hullImpact`];
    for (const id of [MARA, NOOR, BETTINA, JAX, TOMAS, DANE]) {
      expect(impactOf(id)?.factType).toBe("hullImpact");
    }
    expect(impactOf(BETTINA)?.value).toEqual({ fieldId, compartmentId: hit.compartmentId });
    expect(impactOf(TOMAS)?.value).toEqual({ fieldId });
    // Bettina saw the scar there and then; Tomas, a room away, knows nothing of it.
    const [scar] = problemsOf(world, "hullScar");
    expect(world.state.actors[BETTINA]?.knowledge[`${scar?.id}/problem`]).toBeDefined();
    expect(world.state.actors[TOMAS]?.knowledge[`${scar?.id}/problem`]).toBeUndefined();
  });

  it("wakes a sleeper in the hit room; one asleep elsewhere sleeps on", LONG, () => {
    const fixture = settled();
    const { world } = fixture;
    // Dane sleeps in the captain's cabin (the captain has the watch), Jax in the bunkroom.
    const { [MARA]: _captains, ...berths } = world.state.berths;
    world.state.berths = { ...berths, [DANE]: "capt_bunk" as LocalKey };
    setNeed(world, "fatigue", 0.6, [JAX, DANE]);
    runUntil(fixture, 60, (w) => [JAX, DANE].every((id) => asleep(w, id)));
    const hit = strike(world, BUNKROOM_FLOOR);
    expect(hit.compartmentId).toBe(room(world, "quarters"));
    expect(asleep(world, JAX)).toBe(false);
    expect(asleep(world, DANE)).toBe(true);
    expect(hit.drafts.filter((d) => d.type === "wokeUp").map((d) => d.subjectIds)).toEqual([[JAX]]);
  });
});

function asleep(world: World, id: ActorId): boolean {
  const actor = world.state.actors[id];
  return actor !== undefined && isAsleep(actor.activity);
}
