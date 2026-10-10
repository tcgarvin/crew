/**
 * Expeditions A1 (§7.1): the bodies system over time on the bodies fixture: bleeders saved by
 * time and not, stun wearing off, wounds healing and the `wounded` thought outlasting them, the
 * dead left alone, and fatigue and a leg wound multiplying. The times are `core/body.ts`'s
 * formulas at the default bundle's config (`FIXTURE_BODIES`).
 */
import { describe, expect, it } from "vitest";
import { fatigueCapacity } from "../../core/body";
import { dayTicks } from "../../core/clock";
import type { World } from "../../core/types/kernel";
import { effectiveSpeed } from "../spatial/movement";
import {
  BETTINA,
  JAX,
  MARA,
  PRIYA,
  actorOf,
  bodiesWorld,
  bodiesWorldViolations,
  ofType,
  runFor,
  runUntil,
  stepCtxOf,
  woundNow,
} from "./fixtures/bodies-deck";

const secondsSince = (world: World, tick: number) =>
  (world.state.tick - tick) / world.config.values.time.tickRate;

describe("the bodies system (§7.1)", () => {
  it("an untreated grave torso bleeder goes down, then dies at blood 0.25, about 62.5 s", () => {
    const test = bodiesWorld();
    const { world } = test;
    woundNow(world, JAX, { part: "torso", severity: "grave", type: "blaster", byActorId: MARA });
    const woundTick = world.state.tick + 1;
    const events = runUntil(test, 120, (w) => actorOf(w, JAX).availability === "dead");
    const seconds = secondsSince(world, woundTick);
    // (1 − 0.25) / 0.012 = 62.5 s, seen at the bodies system's half-second cadence.
    expect(seconds).toBeGreaterThan(62.4);
    expect(seconds).toBeLessThanOrEqual(63.1);
    const jax = actorOf(world, JAX);
    // Death comes before the 180 s the bleed would take to stop on its own.
    expect(jax.body.wounds[0]?.bleeding).toBe(true);
    expect(ofType(events, "incapacitated").map((e) => e.payload)).toEqual([
      { actorId: JAX, cause: "blood" },
    ]);
    expect(ofType(events, "died").map((e) => e.payload)).toEqual([
      { actorId: JAX, cause: "blood", byActorId: MARA },
    ]);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("a serious torso bleeder stops at 60 s, having lost 0.24, lives and makes it back", () => {
    const test = bodiesWorld();
    const { world } = test;
    woundNow(world, PRIYA, { part: "torso", severity: "serious", type: "blaster" });
    runFor(test, 59);
    const priya = actorOf(world, PRIYA);
    expect(priya.body.wounds[0]?.bleeding).toBe(true);
    runFor(test, 2);
    expect(priya.body.wounds[0]?.bleeding).toBe(false);
    expect(priya.availability).toBe("available");
    // 60 s × 0.004, and about a second of 0.002 a second recovering since.
    expect(priya.body.blood).toBeGreaterThan(0.76 - 1e-9);
    expect(priya.body.blood).toBeLessThan(0.763);
    runFor(test, 120);
    expect(priya.body.blood).toBe(1);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("two stun hits put someone down for 75 s; the stun wounds close when it is gone", () => {
    const test = bodiesWorld();
    const { world } = test;
    const stun = { part: "leftLeg", severity: "serious", type: "stun" } as const;
    woundNow(world, MARA, stun);
    woundNow(world, MARA, stun);
    const hitTick = world.state.tick + 1;
    expect(actorOf(world, MARA).availability).toBe("incapacitated");
    runUntil(test, 120, (w) => actorOf(w, MARA).availability === "available");
    // Up again once 1 − stun ≥ 0.3: 0.3 / 0.004 = 75 s.
    const up = secondsSince(world, hitTick);
    expect(up).toBeGreaterThan(74.5);
    expect(up).toBeLessThanOrEqual(75.6);
    const events = runUntil(test, 200, (w) => actorOf(w, MARA).body.wounds.length === 0);
    expect(secondsSince(world, hitTick)).toBeCloseTo(250, 0);
    expect(ofType(events, "woundHealed")).toHaveLength(2);
    expect(actorOf(world, MARA).capacities).toEqual({
      movement: 1,
      manipulation: 1,
      consciousness: 1,
    });
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("a wound heals to capacities of 1; `wounded` stays while it is open and its term after", () => {
    // A 600 s day and healing at 4 of a wound's damage a day (150 s), to keep the test short;
    // the thought's 0.5 day is 300 s.
    const test = bodiesWorld({ daySeconds: 600, bodies: { healPerDay: 4 } });
    const { world } = test;
    woundNow(world, JAX, { part: "rightLeg", severity: "serious", type: "blunt" });
    const jax = actorOf(world, JAX);
    const wounded = () =>
      jax.thoughts.some((t) => t.key === "wounded" && t.expiresAtTick > world.state.tick);
    runFor(test, 75);
    expect(jax.capacities.movement).toBeGreaterThan(0.84);
    expect(jax.capacities.movement).toBeLessThan(0.86);
    expect(wounded()).toBe(true);
    const events = runUntil(test, 100, () => jax.body.wounds.length === 0);
    expect(ofType(events, "woundHealed")).toHaveLength(1);
    expect(jax.capacities).toEqual({ movement: 1, manipulation: 1, consciousness: 1 });
    expect(jax.body.parts.rightLeg.damage).toBe(0);
    const healedTick = world.state.tick;
    const term = dayTicks(world.config.values, 0.5);
    runFor(test, (term - 40) / 20);
    expect(wounded()).toBe(true);
    runFor(test, 80 / 20);
    expect(wounded()).toBe(false);
    expect(world.state.tick - healedTick).toBeLessThan(term + 60);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("lifts only the body's own incapacity: someone put down unwounded stays down", () => {
    const test = bodiesWorld();
    const { world } = test;
    actorOf(world, PRIYA).availability = "incapacitated";
    runFor(test, 5);
    expect(actorOf(world, PRIYA).availability).toBe("incapacitated");
  });

  it("the dead are never planned, stepped or moved", () => {
    const test = bodiesWorld();
    const { world } = test;
    runFor(test, 5);
    woundNow(world, BETTINA, { part: "head", severity: "grave", type: "blaster" });
    const bettina = actorOf(world, BETTINA);
    const where = { ...bettina.location };
    const needs = { ...bettina.needs };
    const events = runFor(test, 300);
    expect(bettina.availability).toBe("dead");
    expect(bettina.activity).toEqual({ kind: "idle" });
    expect(bettina.movement).toEqual({ kind: "stationary" });
    expect(bettina.location).toEqual(where);
    expect(bettina.needs).toEqual(needs);
    const aboutHer = events.filter(
      (e) => e.subjectIds.includes(BETTINA) && e.type !== "thoughtAdded",
    );
    expect(aboutHer).toEqual([]);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("fatigue and a leg wound multiply, in capacities and in walking speed", () => {
    const test = bodiesWorld();
    const { world } = test;
    const jax = actorOf(world, JAX);
    jax.needs.fatigue = 0.95;
    runFor(test, 1);
    if (jax.location.kind !== "onDeck") throw new Error("Jax is not on deck");
    const actors = Object.values(world.state.actors);
    const speedBefore = effectiveSpeed(stepCtxOf(world).ctx, jax, jax.location, actors);
    // A blaster wound: it bleeds for a minute before it starts to heal, so the leg holds at 0.4.
    woundNow(world, JAX, { part: "leftLeg", severity: "serious", type: "blaster" });
    runFor(test, 1);
    const { urgency, movement } = world.config.values;
    const fatigue = fatigueCapacity(
      jax.needs.fatigue,
      urgency.needSurvivalAbove,
      movement.fatigueSpeedFloor,
    );
    expect(fatigue).toBeLessThan(1);
    expect(jax.capacities.movement).toBeCloseTo(fatigue * 0.7, 9);
    expect(jax.capacities.manipulation).toBeCloseTo(fatigue, 9);
    if (jax.location.kind !== "onDeck") throw new Error("Jax is not on deck");
    const speedAfter = effectiveSpeed(stepCtxOf(world).ctx, jax, jax.location, actors);
    expect(speedAfter / speedBefore).toBeCloseTo(0.7, 9);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });
});
