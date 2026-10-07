/**
 * The damage pass on alert and at port (slice 5 calls 4, 10, 11, 23), headless on the damage
 * fixture: recreation ends when the alert sounds and is not offered until it clears; the officer
 * of the watch walks to the bridge and holds it; a room nobody has covered since the last rock
 * gets a check, the nearest hand on watch (never the captain) is sent and sees the scar; a report
 * or the alert clearing settles the checks and the scars fall back to routine; docked at a port
 * selling plating the ship buys a plate a scar and the crew plate them; at one with none, nothing.
 * Last, a field's worth of rocks thrown by hand ends with every scar patched and the machine
 * mended.
 */
import { describe, expect, it } from "vitest";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { ProblemOfKind } from "../../core/types/work";
import {
  BETTINA,
  JAX,
  MARA,
  NOOR,
  TOMAS,
  loungeStepCtx,
  ofType,
  placeInLounge,
  runFor,
  runUntil,
  setNeed,
  tileNow,
} from "../recreation/fixtures/lounge-deck";
import { currentHold } from "../work/activity";
import {
  BENCH_SEAT,
  CHAIR_SEAT,
  LOUNGE_FLOOR,
  broadcastDamage,
  damageWorld,
  machineAt,
  room,
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

function problems<K extends "compartmentToCheck" | "hullScar" | "hullDamaged">(
  world: World,
  kind: K,
): ProblemOfKind<K>[] {
  return Object.values(world.state.work.problems).filter(
    (p): p is ProblemOfKind<K> => p.kind === kind,
  );
}

const recreating = (world: World): ActorId[] =>
  Object.values(world.state.actors)
    .filter((a) => a.activity.kind === "personal" && a.activity.activity === "recreate")
    .map((a) => a.id);

const holdingBridge = (world: World, id: ActorId): boolean => {
  const actor = world.state.actors[id];
  return actor !== undefined && currentHold(actor.activity) === "bridge";
};

const clearAlert = (world: World): void => {
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete world.state.alert;
};

describe("on alert (call 4)", () => {
  it(
    "a game of cards ends when the alert sounds, and none is offered until it clears",
    LONG,
    () => {
      const fixture = settled();
      const { world } = fixture;
      // Jax (off watch, keen on cards) opens a table in the lounge.
      setNeed(world, "recreation", 0.6, [JAX]);
      runUntil(
        fixture,
        30,
        (w) => recreating(w).includes(JAX) && Object.keys(w.state.social.sessions).length > 0,
      );
      soundAlert(world);
      runFor(fixture, 0.1);
      expect(recreating(world)).toEqual([]);
      expect(Object.keys(world.state.social.sessions)).toHaveLength(0);
      runFor(fixture, 30, (w) => expect(recreating(w)).toEqual([]));
      clearAlert(world);
      runUntil(fixture, 30, (w) => recreating(w).includes(JAX));
    },
  );

  it(
    "the officer of the watch walks to the bridge and holds it until the alert clears",
    LONG,
    () => {
      const fixture = settled();
      const { world } = fixture;
      soundAlert(world);
      runUntil(fixture, 30, (w) => holdingBridge(w, MARA));
      expect(tileNow(world, MARA)).toEqual(CHAIR_SEAT);
      expect(world.state.actors[MARA]?.activity).toMatchObject({
        kind: "personal",
        activity: "holdBridge",
        urgency: "essentialOperation",
        label: "holding the bridge",
      });
      runFor(fixture, 60, (w) => expect(holdingBridge(w, MARA)).toBe(true));
      clearAlert(world);
      runFor(fixture, 0.1);
      expect(holdingBridge(world, MARA)).toBe(false);
    },
  );
});

describe("scouts (call 11)", () => {
  it(
    "a room nobody has covered gets a check; the nearest hand on watch, never the captain, goes and sees the scar",
    LONG,
    () => {
      const fixture = settled();
      const { world } = fixture;
      soundAlert(world);
      runUntil(fixture, 30, (w) => holdingBridge(w, MARA));
      // Everyone on watch in the lounge but the officer when the rock hits the empty gym.
      placeInLounge(world, NOOR, { x: 3, y: 2 });
      placeInLounge(world, TOMAS, LOUNGE_FLOOR);
      placeInLounge(world, BETTINA, { x: 8, y: 2 });
      const hit = strike(world, BENCH_SEAT);
      const gym = room(world, "gym");
      expect(hit.compartmentId).toBe(gym);
      const sent = runUntil(fixture, 5, (_w, seen) =>
        ofType(seen, "scoutSent").some((e) => e.payload.compartmentId === gym),
      );
      const check = problems(world, "compartmentToCheck").find(
        (p) => p.payload.compartmentId === gym,
      );
      expect(check).toMatchObject({ owner: "damage", visibility: "public" });
      expect(check?.baseUrgency).toBe("essentialOperation");
      // No check for the bridge (the officer is there) or the lounge (three on watch are).
      const checked = new Set(
        problems(world, "compartmentToCheck").map((p) => p.payload.compartmentId),
      );
      expect(checked.has(room(world, "bridge"))).toBe(false);
      expect(checked.has(room(world, "lounge"))).toBe(false);
      const scout = ofType(sent, "scoutSent").find((e) => e.payload.compartmentId === gym);
      expect(scout?.payload.officerId).toBe(MARA);
      const scoutId = scout?.payload.scoutId as ActorId;
      expect([NOOR, TOMAS, BETTINA]).toContain(scoutId);
      runUntil(fixture, 30, () => check?.status === "resolved");
      const scar = problems(world, "hullScar").find((p) => p.payload.scarId === hit.scarId);
      expect(world.state.actors[scoutId]?.knowledge[`${scar?.id}/problem`]).toBeDefined();
      expect(holdingBridge(world, MARA)).toBe(true);
    },
  );

  it(
    "a report on the intercom settles a room's check, and the alert clearing settles the rest",
    LONG,
    () => {
      const fixture = settled();
      const { world } = fixture;
      soundAlert(world);
      runUntil(fixture, 30, (w) => holdingBridge(w, MARA));
      strike(world, BENCH_SEAT);
      runFor(fixture, 0.1);
      const open = () => problems(world, "compartmentToCheck").filter((p) => p.status === "open");
      const cabin = room(world, "captains_cabin");
      expect(open().map((p) => p.payload.compartmentId)).toContain(cabin);
      const alert = world.state.alert;
      if (alert === undefined) throw new Error("no alert");
      alert.reports[cabin] = world.state.tick;
      runFor(fixture, 0.1);
      expect(open().map((p) => p.payload.compartmentId)).not.toContain(cabin);
      const scar = problems(world, "hullScar")[0];
      expect(scar?.baseUrgency).toBe("essentialOperation");
      clearAlert(world);
      runFor(fixture, 0.1);
      expect(open()).toEqual([]);
      expect(scar?.baseUrgency).toBe("routineObligation");
    },
  );
});

describe("scouts, once a room a field (slice-5 integration)", () => {
  it(
    "a room looked at is not sent a scout again while the rocks fall, and is once the field ends",
    LONG,
    () => {
      const fixture = settled();
      const { world } = fixture;
      soundAlert(world);
      runUntil(fixture, 30, (w) => holdingBridge(w, MARA));
      strike(world, BENCH_SEAT);
      runFor(fixture, 0.1);
      const cabin = room(world, "captains_cabin");
      const openFor = (id: string) =>
        problems(world, "compartmentToCheck").filter(
          (p) => p.status === "open" && p.payload.compartmentId === id,
        );
      expect(openFor(cabin)).toHaveLength(1);
      const alert = world.state.alert;
      if (alert === undefined) throw new Error("no alert");
      alert.reports[cabin] = world.state.tick;
      runFor(fixture, 0.1);
      expect(openFor(cabin)).toEqual([]);
      // A second rock while the field is active: the cabin was looked at this field.
      strike(world, BENCH_SEAT);
      runFor(fixture, 0.1);
      expect(openFor(cabin)).toEqual([]);
      // The field ends: every room not covered since the last rock gets one more look.
      const field = world.state.field;
      if (field?.phase.kind !== "active") throw new Error("no active field");
      field.phase = {
        kind: "ended",
        enteredTick: field.phase.enteredTick,
        endedTick: world.state.tick,
        how: "crossed",
      };
      runFor(fixture, 0.1);
      expect(openFor(cabin)).toHaveLength(1);
    },
  );
});

describe("plating at port (call 23)", () => {
  it(
    "docked where plating is sold, the ship buys a plate a scar and the crew plate them all",
    { timeout: 60_000 },
    () => {
      const fixture = settled({ kits: false, plating: { count: 5, price: 20 } });
      const { world } = fixture;
      // Both in the lounge, where the crew pass and see them (scars are discovered problems).
      strike(world, LOUNGE_FLOOR, 8);
      strike(world, { x: 3, y: 2 }, 3, "small");
      expect(world.state.hull.integrity).toBe(89);
      const money = world.state.money.balance;
      const events = runUntil(fixture, 280, (w) => w.state.hull.scars.length === 0);
      const bought = ofType(events, "partsBought");
      expect(bought.map((e) => e.payload.count).reduce((a, b) => a + b, 0)).toBe(2);
      expect(world.state.money.balance).toBe(money - 40);
      expect(
        ofType(events, "hullPlated")
          .map((e) => e.payload.recovered)
          .sort(),
      ).toEqual([3, 8]);
      expect(world.state.hull.integrity).toBe(100);
      expect(problems(world, "hullScar").every((p) => p.status === "resolved")).toBe(true);
      expect(problems(world, "hullDamaged").every((p) => p.status === "resolved")).toBe(true);
    },
  );

  it("at a port with no plating nothing is bought and the scars stay", LONG, () => {
    const fixture = settled({ kits: false });
    const { world } = fixture;
    strike(world, LOUNGE_FLOOR, 8);
    const events = runFor(fixture, 60);
    expect(ofType(events, "partsBought")).toHaveLength(0);
    expect(problems(world, "hullDamaged")).toHaveLength(0);
    expect(world.state.hull.scars).toHaveLength(1);
  });
});

describe("a field's worth of rocks, by hand", () => {
  it("ends with every scar patched and the damaged machine mended", { timeout: 60_000 }, () => {
    const fixture = settled();
    const { world } = fixture;
    soundAlert(world);
    const targets = [LOUNGE_FLOOR, { x: 13, y: 3 }, BENCH_SEAT, { x: 20, y: 3 }, { x: 1, y: 3 }];
    const bench = world.state.machines[machineAt(world, "workbench")];
    if (bench === undefined) throw new Error("no workbench");
    for (const [i, tile] of targets.entries()) {
      strike(world, tile, i % 2 === 0 ? 8 : 3, i % 2 === 0 ? "large" : "small");
      if (tile === BENCH_SEAT) damageMachine(loungeStepCtx(world).ctx, bench, 0.5);
      // Word of it goes round the ship, as the intercom (W3) will carry it.
      broadcastDamage(world, MARA);
      runFor(fixture, 15);
    }
    // The field has passed: the alert stands down, and the work goes on at routine.
    clearAlert(world);
    runUntil(
      fixture,
      400,
      (w) => w.state.hull.scars.every((s) => s.patched) && bench.integrity === 1,
    );
    expect(world.state.hull.integrity).toBe(100 - (8 * 3 + 3 * 2) / 2);
  });
});
