/**
 * §hand-truck-trips: hauling freight to and from the dock with the hand truck. One crew member
 * fetches it from the hold, takes several hauls at once (one activity, several claims), loads the
 * crates onto it, pushes it to their destinations and parks it aboard; the truck carries at most
 * its capacity and is pushed by one person at a time; without it hauling is one crate in the hands.
 * A trip stopped on the dock sets the truck and its load down there, and the work is picked up
 * again; a truck still on the dock at departure is handed aboard, never left at the warehouse. A
 * save made mid-trip restores and finishes the trip.
 */
import { describe, expect, it } from "vitest";
import { isInDockArea, isOnDock } from "../../core/docks";
import { restoreThroughSchema6 } from "../../core/fixtures/frozen-migrations";
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { getRenderFrame } from "../../core/render";
import type { Actor } from "../../core/types/actor";
import type { ItemId, JobId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { DECK12 } from "../spatial/fixtures/deck-12x8";
import { STOWAGE_TILES } from "../work/fixtures/crew-deck";
import {
  MINUTE,
  QUAY_WORK,
  TRUCK,
  accept,
  dockWorkWorld,
  offerFreight,
  onTile,
  run,
  setCourse,
  tileAt,
} from "./fixtures-dock";

function truckOf(world: World) {
  const truck = Object.values(world.state.items).find((i) => i.defId === TRUCK);
  if (truck === undefined) throw new Error("no hand truck");
  return truck;
}

function crates(world: World, id: JobId): ItemId[] {
  const job = world.state.jobs[id];
  if (job === undefined) throw new Error(`no job ${id}`);
  return [...job.cargoItemIds];
}

/** Crates riding on a truck right now. */
function onTruck(world: World): ItemId[] {
  return Object.values(world.state.items)
    .filter((i) => {
      const location = i.location;
      if (location.kind !== "inContainer") return false;
      return world.state.items[location.containerId]?.defId === TRUCK;
    })
    .map((i) => i.id);
}

function tripOf(actor: Actor) {
  return actor.activity.kind === "task" ? actor.activity.haul : undefined;
}

/** The actor on a hand-truck trip, if any. */
function pusher(world: World): Actor | undefined {
  return Object.values(world.state.actors).find((a) => tripOf(a) !== undefined);
}

const inHold = (world: World, itemId: ItemId) =>
  onTile(STOWAGE_TILES, tileAt(world.state.items[itemId]?.location));

const aboard = (world: World, itemId: ItemId) => {
  const location = world.state.items[itemId]?.location;
  return location?.kind === "onDeck" && !isOnDock(world.content, world.state, location);
};

/** Watch a run: the most crates seen on the truck at once, and who held several claims. */
function tripLog() {
  const log = {
    maxLoad: 0,
    maxHeld: 0,
    pushers: new Set<string>(),
    handHauls: new Set<string>(),
    labels: new Set<string>(),
  };
  const each = (w: World) => {
    log.maxLoad = Math.max(log.maxLoad, onTruck(w).length);
    for (const actor of Object.values(w.state.actors)) {
      const trip = tripOf(actor);
      if (trip !== undefined) {
        log.pushers.add(actor.id);
        if (actor.activity.kind === "task") log.labels.add(actor.activity.label ?? "");
        log.maxHeld = Math.max(log.maxHeld, trip.legs.length + 1);
      }
    }
    for (const item of Object.values(w.state.items)) {
      if (item.jobId !== undefined && item.location.kind === "carriedBy") {
        log.handHauls.add(item.location.actorId);
      }
    }
  };
  return { log, each };
}

describe("loading with the hand truck (§hand-truck-trips)", () => {
  it("fetches the truck, takes every crate up in one trip and parks the truck aboard", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const home = tileAt(truckOf(world).location);
    expect(onTile(STOWAGE_TILES, home)).toBe(true);
    const id = offerFreight(test);
    const ids = crates(world, id);
    accept(test, id);
    let sawFrame = false;
    const { log, each } = tripLog();
    const events = run(
      test,
      4 * MINUTE,
      (w) => ids.every((itemId) => inHold(w, itemId)) && pusher(w) === undefined,
      (w) => {
        each(w);
        // The render frame shows the truck in the pusher's hands with the crates on it.
        const loaded = onTruck(w);
        if (loaded.length < 2) return;
        const frame = getRenderFrame(w);
        const truck = frame.items.find((i) => i.defId === TRUCK);
        expect(truck?.location.kind).toBe("carried");
        const riding = frame.items.filter(
          (i) => i.location.kind === "container" && i.location.containerId === truck?.id,
        );
        expect(riding.map((i) => i.id).sort()).toEqual([...loaded].sort());
        sawFrame = true;
      },
    );
    expect(ids.every((itemId) => inHold(world, itemId))).toBe(true);
    // One person, one trip: three claims held at once, all three crates on the truck together.
    expect(log.pushers.size).toBe(1);
    expect(log.maxHeld).toBe(3);
    expect(log.maxLoad).toBe(3);
    expect(log.handHauls.size).toBe(0);
    expect(sawFrame).toBe(true);
    for (const label of ["fetching the hand truck", "hauling 3 crates"]) {
      expect(log.labels).toContain(label);
    }
    const stowed = events.filter(
      (e) => e.type === "taskCompleted" && e.payload.haul?.to === "ship",
    );
    expect(stowed).toHaveLength(3);
    expect(new Set(stowed.map((e) => e.subjectIds[2]))).toEqual(log.pushers);
    // The truck is parked aboard, empty, and nobody is pushing it.
    const truck = truckOf(world);
    expect(truck.location.kind).toBe("onDeck");
    expect(aboard(world, truck.id)).toBe(true);
    expect(onTruck(world)).toEqual([]);
    // The ship then leaves as usual.
    setCourse(test);
    run(test, 2 * MINUTE, (w) => w.state.travel.stage === "undocking");
    expect(world.state.travel.stage).toBe("undocking");
  });

  it("carries no more than its capacity, and the rest goes by hand or on the next trip", () => {
    const test = dockWorkWorld({ truck: 2 });
    const { world } = test;
    const id = offerFreight(test, TINY.port, TINY.port2, 5);
    const ids = crates(world, id);
    expect(ids).toHaveLength(5);
    accept(test, id);
    const { log, each } = tripLog();
    run(test, 6 * MINUTE, (w) => ids.every((itemId) => inHold(w, itemId)), each);
    expect(ids.every((itemId) => inHold(world, itemId))).toBe(true);
    expect(log.maxLoad).toBe(2);
    expect(log.maxHeld).toBe(2);
  });

  it("is pushed by one person at a time: the other crew member hauls by hand meanwhile", () => {
    const test = dockWorkWorld({ truck: 2 });
    const { world } = test;
    const id = offerFreight(test, TINY.port, TINY.port2, 5);
    const ids = crates(world, id);
    accept(test, id);
    const { log, each } = tripLog();
    let together = false;
    run(
      test,
      6 * MINUTE,
      (w) => ids.every((itemId) => inHold(w, itemId)),
      (w) => {
        each(w);
        const user = pusher(w);
        const byHand = Object.values(w.state.items).some(
          (i) =>
            i.jobId !== undefined &&
            i.location.kind === "carriedBy" &&
            i.location.actorId !== user?.id,
        );
        if (user !== undefined && byHand) together = true;
      },
    );
    // workViolations (checked every tick) holds the truck to one trip and one pusher.
    expect(together).toBe(true);
    expect(log.handHauls.size).toBeGreaterThanOrEqual(1);
  });

  it("hauls one crate at a time in the hands without a truck", () => {
    const test = dockWorkWorld();
    const { world } = test;
    const id = offerFreight(test);
    const ids = crates(world, id);
    accept(test, id);
    const { log, each } = tripLog();
    run(test, 4 * MINUTE, (w) => ids.every((itemId) => inHold(w, itemId)), each);
    expect(ids.every((itemId) => inHold(world, itemId))).toBe(true);
    expect(log.pushers.size).toBe(0);
    expect(log.maxLoad).toBe(0);
  });
});

describe("unloading with the hand truck (§hand-truck-trips)", () => {
  it("takes the crates down to the bay together, is paid once, and brings the truck back aboard", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const id = offerFreight(test);
    const ids = crates(world, id);
    accept(test, id);
    setCourse(test);
    run(test, 6 * MINUTE, (w) => w.state.travel.stage === "transit");
    expect(ids.every((itemId) => aboard(world, itemId))).toBe(true);
    run(test, 6 * MINUTE, (w) => w.state.travel.stage === "docked");
    expect(world.state.travel.stage).toBe("docked");
    const { log, each } = tripLog();
    let bayWithTruck = false;
    const events = run(
      test,
      6 * MINUTE,
      (w) => w.state.jobs[id]?.status === "paid" && pusher(w) === undefined,
      (w) => {
        each(w);
        const user = pusher(w);
        if (user === undefined) return;
        if (onTile(QUAY_WORK.bay, tileAt(user.location)) && onTruck(w).length > 0) {
          bayWithTruck = true;
        }
      },
    );
    expect(world.state.jobs[id]?.status).toBe("paid");
    expect(log.maxLoad).toBe(3);
    expect(log.handHauls.size).toBe(0);
    expect(bayWithTruck).toBe(true);
    expect(log.labels).toContain("hauling 3 crates");
    expect(log.labels).toContain("returning the hand truck");
    const ashore = events.filter(
      (e) => e.type === "taskCompleted" && e.payload.haul?.to === "port",
    );
    expect(ashore).toHaveLength(3);
    expect(events.filter((e) => e.type === "paymentMade" && e.payload.jobId === id)).toHaveLength(
      1,
    );
    // The truck came back up the ramp: it is aboard, not on the dock.
    expect(aboard(world, truckOf(world).id)).toBe(true);
  });
});

describe("a trip stopped part way (§stopping-a-trip-early)", () => {
  /** Run until the pusher stands on the dock with `n` crates on the truck. */
  function loadedOnDock(test: TestWorld, n: number): Actor {
    run(test, 4 * MINUTE, (w) => {
      const user = pusher(w);
      return (
        user !== undefined && isOnDock(w.content, w.state, user.location) && onTruck(w).length >= n
      );
    });
    const user = pusher(test.world);
    if (user === undefined) throw new Error("nobody took the truck");
    return user;
  }

  it("sets the truck and its load down on the dock when something more urgent comes up", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const id = offerFreight(test);
    const ids = crates(world, id);
    accept(test, id);
    const user = loadedOnDock(test, 2);
    const where = tileAt(user.location);
    const loaded = onTruck(world);
    // Something more urgent than hauling (as the planner hands over a survival need or an
    // emergency): a rest aboard at immediate-survival urgency.
    user.pendingIntent = {
      kind: "personal",
      activity: "rest",
      tile: { x: 6, y: 2 },
      urgency: "immediateSurvival",
      trace: { candidates: 1, chosenReason: "test", rejected: [] },
    };
    const stopped = run(test, 1);
    expect(tripOf(world.state.actors[user.id] as Actor)).toBeUndefined();
    expect(stopped.some((e) => e.type === "taskReleased")).toBe(true);
    // Everything that was on the truck lies on the dock beside it; nothing rides on it.
    const truck = truckOf(world);
    expect(isOnDock(world.content, world.state, truck.location)).toBe(true);
    expect(onTruck(world)).toEqual([]);
    for (const itemId of loaded) {
      const location = world.state.items[itemId]?.location;
      expect(location?.kind).toBe("onDeck");
      expect(isOnDock(world.content, world.state, location ?? truck.location)).toBe(true);
      const tile = tileAt(location);
      expect(
        tile === undefined || where === undefined ? false : Math.abs(tile.x - where.x) <= 1,
      ).toBe(true);
    }
    // The loading is finished all the same (the truck fetched from the dock, or the crates by
    // hand), and the truck is aboard before the ship leaves.
    setCourse(test);
    const rest = run(test, 8 * MINUTE, (w) => w.state.travel.stage === "transit");
    expect(world.state.travel.stage).toBe("transit");
    expect(ids.every((itemId) => aboard(world, itemId))).toBe(true);
    expect(aboard(world, truckOf(world).id)).toBe(true);
    expect(rest.some((e) => e.type === "leftOnDock")).toBe(false);
  });

  it("sets everything down where the pusher is when they cannot go on", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const id = offerFreight(test);
    accept(test, id);
    const user = loadedOnDock(test, 1);
    const loaded = onTruck(world);
    user.availability = "incapacitated";
    const stopped = run(test, 1);
    expect(tripOf(world.state.actors[user.id] as Actor)).toBeUndefined();
    expect(onTruck(world)).toEqual([]);
    expect(stopped.filter((e) => e.type === "taskReleased").map((e) => e.payload.reason)).toContain(
      "incapacitated",
    );
    for (const itemId of [...loaded, truckOf(world).id]) {
      const location = world.state.items[itemId]?.location;
      expect(location !== undefined && isOnDock(world.content, world.state, location)).toBe(true);
    }
    // No claim survives the trip.
    expect(Object.values(world.state.work.claims).some((c) => c.ownerActorId === user.id)).toBe(
      false,
    );
  });

  it("hands a truck still on the dock aboard when the dock goes, never leaving it at the warehouse", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const truck = truckOf(world);
    // Dropped on the quay with nothing left to haul: nobody's work will bring it back.
    truck.location = { kind: "onDeck", deckId: DECK12.deck, x: 5.5, y: 10.5 };
    world.caches.dirty.inventory = true;
    expect(isOnDock(world.content, world.state, truck.location)).toBe(true);
    setCourse(test);
    const events = run(test, 4 * MINUTE, (w) => w.state.travel.stage === "departing");
    expect(world.state.travel.stage).toBe("departing");
    expect(events.filter((e) => e.type === "gearBroughtAboard").map((e) => e.payload)).toEqual([
      { itemId: truck.id, portId: TINY.port },
    ]);
    expect(events.some((e) => e.type === "leftOnDock")).toBe(false);
    expect(tileAt(truckOf(world).location)).toEqual(QUAY_WORK.cargoRampTop);
  });

  it("restores a save made mid-trip and finishes the trip the same way", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { kernel, world } = test;
    const id = offerFreight(test);
    const ids = crates(world, id);
    accept(test, id);
    loadedOnDock(test, 2);
    const user = pusher(world);
    const trip = user === undefined ? undefined : tripOf(user);
    expect(trip?.legs.length).toBe(2);
    const blob = JSON.parse(JSON.stringify(kernel.serialize(world)));
    const restored = kernel.restore(blob, world.content);
    expect(restored.state).toStrictEqual(world.state);
    const copy = { ...test, world: restored };
    const done = (w: World) => ids.every((itemId) => inHold(w, itemId)) && pusher(w) === undefined;
    run(test, 4 * MINUTE, done);
    run(copy, 4 * MINUTE, done);
    expect(ids.every((itemId) => inHold(restored, itemId))).toBe(true);
    expect(aboard(restored, truckOf(restored).id)).toBe(true);
    expect(restored.state).toStrictEqual(world.state);
  });
});

describe("a trip planned on a wrong belief (§stopping-a-trip-early)", () => {
  /** Run until someone has set out on a trip but has not taken the truck yet. */
  function setOut(test: TestWorld): Actor {
    run(test, MINUTE, (w) => pusher(w) !== undefined);
    const user = pusher(test.world);
    if (user === undefined) throw new Error("nobody set out with the truck");
    expect(truckOf(test.world).location.kind).toBe("onDeck");
    return user;
  }

  it("hauls the lead crate by hand when the truck is not where they thought", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const id = offerFreight(test);
    const ids = crates(world, id);
    accept(test, id);
    const user = setOut(test);
    const trip = tripOf(user);
    if (trip === undefined || user.activity.kind !== "task") throw new Error("no trip");
    const lead = user.activity.taskId;
    // Someone moved it while they were on their way (truth only: nobody saw it go).
    const truck = truckOf(world);
    truck.location = { kind: "onDeck", deckId: DECK12.deck, x: 0.5, y: 0.5 };
    world.caches.dirty.inventory = true;
    const { log, each } = tripLog();
    const events = run(
      test,
      MINUTE,
      (w) => (w.state.actors[user.id] as Actor).activity.kind === "idle",
      each,
    );
    // Same task, now a hand haul; the other hauls were let go without blocking anyone.
    expect(log.handHauls.has(user.id)).toBe(true);
    expect(events.some((e) => e.type === "taskBlocked")).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "taskCompleted" && e.payload.taskId === lead && e.subjectIds[2] === user.id,
      ),
    ).toBe(true);
    run(test, 4 * MINUTE, (w) => ids.every((itemId) => inHold(w, itemId)));
    expect(ids.every((itemId) => inHold(world, itemId))).toBe(true);
  });

  it("drops a leg whose crate is not where they thought and takes the rest", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const id = offerFreight(test);
    const ids = crates(world, id);
    accept(test, id);
    const user = setOut(test);
    const trip = tripOf(user);
    if (trip === undefined) throw new Error("no trip");
    const leg = trip.legs[0];
    const legTask = leg === undefined ? undefined : world.state.work.tasks[leg.taskId];
    if (legTask?.target.kind !== "item") throw new Error("no leg");
    const gone = legTask.target.itemId;
    // That crate is already aboard (truth only), out of the pusher's sight.
    const crate = world.state.items[gone];
    if (crate === undefined) throw new Error("no crate");
    crate.location = { kind: "onDeck", deckId: DECK12.deck, x: 9.5, y: 6.5 };
    world.caches.dirty.inventory = true;
    const { log, each } = tripLog();
    const events = run(
      test,
      2 * MINUTE,
      (w) => (w.state.actors[user.id] as Actor).activity.kind === "idle",
      each,
    );
    expect(
      events.some(
        (e) =>
          e.type === "taskReleased" &&
          e.payload.taskId === legTask.id &&
          e.subjectIds[0] === user.id,
      ),
    ).toBe(true);
    // The other two still rode up together.
    expect(log.maxLoad).toBe(2);
    run(test, 4 * MINUTE, (w) => ids.every((itemId) => inHold(w, itemId)));
    expect(ids.every((itemId) => inHold(world, itemId))).toBe(true);
  });
});

describe("a schema-3 save", () => {
  it("gets the hand truck stowed in the hold, once, and the crew take it up", () => {
    const test = dockWorkWorld();
    const { kernel, world } = test;
    expect(Object.values(world.state.items).some((i) => i.defId === TRUCK)).toBe(false);
    const envelope = kernel.serialize(world);
    const state = structuredClone(envelope.state);
    state.schemaVersion = 3;
    const nextItem = state.nextId.item;
    const restored = restoreThroughSchema6(
      { ...envelope, schemaVersion: 3, state },
      world.content,
      test.registry,
    );
    const trucks = Object.values(restored.state.items).filter((i) => i.defId === TRUCK);
    expect(trucks.map((t) => t.id)).toEqual([`i${nextItem}`]);
    expect(restored.state.nextId.item).toBe(nextItem + 1);
    expect(tileAt(trucks[0]?.location)).toEqual(STOWAGE_TILES[0]);
    expect(checkInvariants(restored.state)).toEqual([]);
    // A save that already has one keeps just that one.
    const again = kernel.serialize(restored);
    const twice = restoreThroughSchema6(
      { ...again, schemaVersion: 3, state: { ...structuredClone(again.state), schemaVersion: 3 } },
      world.content,
      test.registry,
    );
    expect(Object.values(twice.state.items).filter((i) => i.defId === TRUCK)).toHaveLength(1);
    // And it is used.
    const copy = { ...test, world: restored };
    const id = offerFreight(copy);
    const ids = crates(restored, id);
    accept(copy, id);
    const { log, each } = tripLog();
    run(copy, 4 * MINUTE, (w) => ids.every((itemId) => inHold(w, itemId)), each);
    expect(log.maxLoad).toBeGreaterThanOrEqual(2);
  });
});

describe("hand-truck freight custody (§freight-hand-off-on-the-dock)", () => {
  it("never counts a crate on the truck as delivered or stowed", () => {
    const test = dockWorkWorld({ truck: 4 });
    const { world } = test;
    const id = offerFreight(test);
    accept(test, id);
    run(test, 4 * MINUTE, (w) => onTruck(w).length > 0, undefined);
    for (const itemId of onTruck(world)) {
      const location = world.state.items[itemId]?.location;
      if (location === undefined) throw new Error("lost a crate");
      expect(isInDockArea(world.content, world.state, location, "deliveryBay")).toBe(false);
      expect(inHold(world, itemId)).toBe(false);
    }
    expect(getRenderFrame(world).headline).toContain("0 of 3 crates aboard");
  });
});
