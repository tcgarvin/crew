/**
 * §rock-impacts: the rocks (slice 5 calls 2, 5, 6, 8, 17). Impacts are uniform over the hull: every
 * tile is hit in time and each room takes its share of tiles. The helm threads the field: skill 10
 * takes rocks at 60 % of the rate, an empty helm at 150 %, and being stuck at 70 % of that.
 * Scripted impacts land at their second and stand in for random ones. A large rock covers nine
 * tiles (fewer at the hull's edge) and costs the hull once, with one scar. Someone standing where
 * a rock comes through has a near miss. Random rocks can sink the ship, and a lost ship never
 * steps again.
 */
import { describe, expect, it } from "vitest";
import { FIXTURE_FIELD } from "../../core/fixtures/ship-life";
import { hullFootprint } from "../../core/hull";
import { createRngApi } from "../../core/rng";
import type { FieldId, ScarId } from "../../core/types/ids";
import type { HullScar } from "../../core/types/state";
import {
  BETTINA,
  FIELD,
  compartment,
  fieldOf,
  fieldWorld,
  fieldWorldViolations,
  ofType,
  runUntil,
  scheduleField,
  secondsOf,
  underWay,
} from "./fixtures/field-deck";
import { arrivalChance, helmRateFactor, randomCentre, randomImpactRate } from "./impacts";

describe("where rocks land (call 5)", () => {
  it("covers every hull tile over two hundred heavy fields' worth of rocks, the hold at its share of tiles", () => {
    const { world } = fieldWorld({ seed: 11 });
    const deck = world.content.decks[FIELD.deck];
    if (deck === undefined) throw new Error("no deck");
    const footprint = hullFootprint(deck);
    const rng = createRngApi(world.state);
    // A heavy field expects nine rocks; two hundred of them.
    const draws = 200 * 9;
    const hits = new Map<string, number>();
    let inHold = 0;
    for (let i = 0; i < draws; i++) {
      const tile = randomCentre(rng, footprint);
      hits.set(`${tile.x},${tile.y}`, (hits.get(`${tile.x},${tile.y}`) ?? 0) + 1);
      if (deck.tiles[tile.y]?.charAt(tile.x) === "H") inHold += 1;
    }
    expect(hits.size).toBe(footprint.length);
    const holdTiles = footprint.filter((t) => deck.tiles[t.y]?.charAt(t.x) === "H").length;
    expect(Math.abs(inHold / draws - holdTiles / footprint.length)).toBeLessThan(0.03);
  });
});

describe("the rate (calls 2, 8, 9)", () => {
  const { config } = fieldWorld().world;
  const values = config.values;

  it("is threaded by the helm: 60 % at skill 10, 150 % with nobody there", () => {
    expect(helmRateFactor(values, { manned: true, piloting: 10 })).toBeCloseTo(0.6, 10);
    expect(helmRateFactor(values, { manned: true, piloting: 0 })).toBe(1);
    expect(helmRateFactor(values, { manned: false })).toBe(1.5);
    const base = values.field.severities.heavy.impactsPerMinute;
    const at = (helm: Parameters<typeof helmRateFactor>[1], stuck = false) =>
      randomImpactRate(values, "heavy", helm, stuck, 0);
    expect(at({ manned: true, piloting: 10 })).toBeCloseTo(0.6 * base, 10);
    expect(at({ manned: false })).toBeCloseTo(1.5 * base, 10);
    expect(at({ manned: true, piloting: 10 }, true)).toBeCloseTo(0.7 * 0.6 * base, 10);
  });

  it("is thinned by the scripted impacts, so they replace random ones rather than add to them", () => {
    const helm = { manned: true, piloting: 0 } as const;
    // A light field expects 2/min × 1.5 min = 3 rocks.
    expect(randomImpactRate(values, "light", helm, false, 1)).toBeCloseTo((2 * 2) / 3, 10);
    expect(randomImpactRate(values, "light", helm, false, 3)).toBe(0);
  });

  it("arrives as a Poisson process, at most a tick's chance of one", () => {
    expect(arrivalChance(0, 0.05)).toBe(0);
    expect(arrivalChance(60, 1)).toBeCloseTo(1 - Math.exp(-1), 10);
  });

  it("over a long field, lands as many rocks as the rate says", { timeout: 30_000 }, () => {
    // A heavy field stretched to ten minutes, nobody at the helm: 4 × 1.5 × 10 = 60 expected.
    const heavy = { ...FIXTURE_FIELD.severities.heavy, lengthSeconds: 600 };
    const severities = { ...FIXTURE_FIELD.severities, heavy };
    const test = fieldWorld({ watch: false, field: { severities } });
    underWay(test, false);
    scheduleField(test, {
      severity: "heavy",
      detection: "unseen",
      windowTicks: [0, 0],
      scripted: [],
    });
    test.world.state.hull.max = 10_000;
    test.world.state.hull.integrity = 10_000;
    runUntil(test, 700, (w) => w.state.field?.phase.kind === "ended");
    expect(fieldOf(test.world).impacts).toBeGreaterThan(60 - 3 * Math.sqrt(60));
    expect(fieldOf(test.world).impacts).toBeLessThan(60 + 3 * Math.sqrt(60));
  });
});

describe("an impact (calls 6, 10, 17, 20)", { timeout: 30_000 }, () => {
  it("lands a scripted rock at its second; a large one covers nine tiles and costs the hull once", () => {
    const test = fieldWorld();
    underWay(test);
    const field = scheduleField(test, {
      severity: "light",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [{ atSeconds: 5, target: { kind: "tile", x: 5, y: 2 }, rock: "large" }],
    });
    const events = runUntil(test, 30, () => field.scripted[0]?.firedTick !== undefined);
    const phase = field.phase;
    if (phase.kind !== "active") throw new Error("field not active");
    const impact = ofType(events, "asteroidImpact").find((e) => e.payload.scripted);
    expect(impact?.tick).toBe(phase.enteredTick + secondsOf(test.world, 5));
    expect(impact?.payload.tiles).toHaveLength(9);
    expect(impact?.payload).toMatchObject({
      tile: { x: 5, y: 2 },
      rock: "large",
      hullDamage: 8,
      compartmentId: compartment(test.world, "hold"),
    });
    const scar = test.world.state.hull.scars.find((s) => s.id === impact?.payload.scarId);
    expect(scar).toMatchObject({ tile: { x: 5, y: 2 }, damage: 8, recovered: 0, patched: false });
    expect(test.world.state.hull.integrity).toBe(100 - field.hullLost);
    expect(fieldWorldViolations(test.world)).toEqual([]);
  });

  it("clips a large rock at the hull's corner", () => {
    const test = fieldWorld();
    underWay(test);
    const field = scheduleField(test, {
      severity: "light",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [{ atSeconds: 0, target: { kind: "tile", x: 0, y: 0 }, rock: "large" }],
    });
    const events = runUntil(test, 30, () => field.scripted[0]?.firedTick !== undefined);
    const impact = ofType(events, "asteroidImpact").find((e) => e.payload.scripted);
    expect(impact?.payload.tiles).toHaveLength(4);
    expect(impact?.payload.hullDamage).toBe(8);
  });

  it("lands a rock aimed at a room on one of its tiles", () => {
    const test = fieldWorld();
    underWay(test);
    const engineering = compartment(test.world, "engineering");
    const field = scheduleField(test, {
      severity: "light",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [{ atSeconds: 0, target: { kind: "compartment", compartmentId: engineering } }],
    });
    const events = runUntil(test, 30, () => field.scripted[0]?.firedTick !== undefined);
    const impact = ofType(events, "asteroidImpact").find((e) => e.payload.scripted);
    expect(impact?.payload.compartmentId).toBe(engineering);
    expect(impact?.payload.tile.x).toBeGreaterThanOrEqual(9);
    expect(impact?.payload.tile.x).toBeLessThanOrEqual(11);
  });

  it("gives whoever stands where it comes through a near miss, and hurts nobody", () => {
    const test = fieldWorld();
    underWay(test);
    const field = scheduleField(test, {
      severity: "light",
      detection: "rolled",
      windowTicks: [0, 0],
      scripted: [{ atSeconds: 0, target: { kind: "tile", x: 6, y: 4 }, rock: "small" }],
    });
    runUntil(test, 30, (w) => w.state.tick === field.startsAtTick - 1);
    const bettina = test.world.state.actors[BETTINA];
    if (bettina === undefined) throw new Error("no Bettina");
    bettina.movement = { kind: "stationary" };
    bettina.location = { kind: "onDeck", deckId: FIELD.deck, x: 6.5, y: 4.5 };
    const events = runUntil(test, 2, () => field.scripted[0]?.firedTick !== undefined);
    expect(ofType(events, "nearMiss").map((e) => e.payload)).toEqual([
      { fieldId: field.id, actorId: BETTINA, compartmentId: compartment(test.world, "hold") },
    ]);
    expect(bettina.thoughts.some((t) => t.key === "nearMiss")).toBe(true);
  });
});

describe("losing the ship (calls 13, 24)", { timeout: 30_000 }, () => {
  it("random rocks can sink it: shipLost, lostAtTick, and the kernel halts lost from then on", () => {
    const test = fieldWorld({ watch: false });
    underWay(test, false);
    const old: HullScar = {
      id: "r1" as ScarId,
      fieldId: "f0" as FieldId,
      tile: { x: 4, y: 2 },
      compartmentId: compartment(test.world, "hold"),
      rock: "large",
      damage: 95,
      recovered: 0,
      patched: false,
      tick: 0,
    };
    test.world.state.hull = { integrity: 5, max: 100, scars: [old] };
    test.world.state.nextId = { ...test.world.state.nextId, scar: 2 };
    scheduleField(test, {
      severity: "brutal",
      detection: "unseen",
      windowTicks: [0, 0],
      scripted: [],
    });
    const events = runUntil(test, 200, (w) => w.state.hull.lostAtTick !== undefined);
    const hull = test.world.state.hull;
    expect(hull.integrity).toBe(0);
    expect(ofType(events, "shipLost").map((e) => e.tick)).toEqual([hull.lostAtTick]);
    // The last scar records what was actually lost, so the bar's arithmetic holds at zero.
    expect(hull.scars.reduce((sum, s) => sum + s.damage, 0)).toBe(100);
    expect(fieldWorldViolations(test.world)).toEqual([]);
    const after = test.kernel.advance(test.world, 10);
    expect(after.halt).toEqual({ kind: "lost" });
    expect(after.ticksAdvanced).toBe(0);
  });
});
