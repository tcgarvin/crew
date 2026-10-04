/**
 * D63: port work is physical on a dock. An offer's crates are staged on the staging area, nobody's
 * until taken (withdrawn on decline, expiry or departure; staged when an offer made in flight
 * reaches its dock); the crew carry them aboard by hand and down to the delivery bay at the far
 * end, where custody pays the job once before the port takes the crates in; departure prep waits
 * for accepted freight still on the dock; parts are bought at the stall, or through the gate where
 * the dock has none, and carried aboard; passengers come and go through the gate; a schema-3 save
 * docked mid-loading has its stored freight moved onto the dock.
 */
import { describe, expect, it } from "vitest";
import { isInDockArea, isOnDock } from "../../core/docks";
import { restoreThroughSchema6 } from "../../core/fixtures/frozen-migrations";
import { TINY } from "../../core/fixtures/tiny-content";
import { getRenderFrame } from "../../core/render";
import type { ActorId, JobId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { DECK12 } from "../spatial/fixtures/deck-12x8";
import { addEngineFault } from "../work/fixtures/crew-deck";
import {
  MINUTE,
  PARTS,
  QUAY_WORK,
  accept,
  dockWorkWorld,
  offerFreight,
  onTile,
  run,
  send,
  setCourse,
  tileAt,
} from "./fixtures-dock";

function job(world: World, id: JobId) {
  const found = world.state.jobs[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
}

function crateLocations(world: World, id: JobId) {
  return job(world, id).cargoItemIds.map((itemId) => world.state.items[itemId]?.location);
}

const loadWork = (world: World, id: JobId) =>
  Object.values(world.state.work.problems).filter(
    (p) => p.kind === "cargoToLoad" && p.payload.jobId === id,
  );

describe("freight on offer is staged on the dock (D63)", () => {
  it("sets an offer's crates out on the staging area, nobody's, and withdraws them on decline", () => {
    const test = dockWorkWorld();
    const { world } = test;
    const id = offerFreight(test);
    const offered = job(world, id);
    expect(offered.status).toBe("offered");
    expect(offered.cargoItemIds).toHaveLength(3);
    // One crate per tile, all on the staging area; no work exists for them.
    const tiles = crateLocations(world, id).map(tileAt);
    expect(tiles.every((t) => onTile(QUAY_WORK.staging, t))).toBe(true);
    expect(new Set(tiles.map((t) => `${t?.x},${t?.y}`)).size).toBe(3);
    expect(loadWork(world, id)).toEqual([]);
    const frame = getRenderFrame(world).items.filter((i) => i.jobId === id);
    expect(frame.map((i) => i.offered)).toEqual([true, true, true]);
    // Nobody picks them up while they are on offer.
    run(test, MINUTE / 2);
    expect(crateLocations(world, id).map(tileAt)).toEqual(tiles);

    send(test, { source: "player", kind: "declineJob", payload: { jobId: id } });
    const events = run(test, 1);
    expect(job(world, id).cargoItemIds).toEqual([]);
    expect(offered.cargoItemIds.every((itemId) => world.state.items[itemId] === undefined)).toBe(
      true,
    );
    expect(events.some((e) => e.type === "freightWithdrawn")).toBe(true);
  });

  it("withdraws an offer's crates when it expires", () => {
    const test = dockWorkWorld();
    const id = offerFreight(test);
    job(test.world, id).expiresAtTick = test.world.state.tick + 1;
    run(test, 3);
    expect(job(test.world, id).status).toBe("expired");
    expect(job(test.world, id).cargoItemIds).toEqual([]);
  });

  it("stages an offer made in flight when its dock comes alongside, and withdraws it on leaving", () => {
    const test = dockWorkWorld();
    const { world } = test;
    setCourse(test);
    run(test, 4 * MINUTE, (w) => w.state.travel.stage === "transit");
    const id = offerFreight(test, TINY.port2, TINY.port);
    expect(job(world, id).cargoItemIds).toEqual([]);
    run(test, 4 * MINUTE, (w) => w.state.travel.stage === "docking");
    // The dock slides in with the crates already on it.
    expect(
      crateLocations(world, id)
        .map(tileAt)
        .every((t) => onTile(QUAY_WORK.staging, t)),
    ).toBe(true);
    run(test, MINUTE, (w) => w.state.travel.stage === "docked");
    setCourse(test, TINY.port);
    run(test, MINUTE, (w) => w.state.travel.stage === "preparingDeparture");
    expect(job(world, id).status).toBe("offered");
    expect(job(world, id).cargoItemIds).toEqual([]);
  });
});

describe("taking a job before the crew's first look (D63)", () => {
  it("still leaves every crew member briefed on the ship's stores, and on the freight", () => {
    const test = dockWorkWorld();
    const { world } = test;
    // A fresh crew: nobody has looked around yet.
    for (const actor of Object.values(world.state.actors)) actor.knowledge = {};
    const id = offerFreight(test);
    accept(test, id);
    const freight = new Set<string>(job(world, id).cargoItemIds);
    const stores = Object.values(world.state.items).filter(
      (item) => item.location.kind === "onDeck" && !freight.has(item.id),
    );
    expect(stores.length).toBeGreaterThan(0);
    run(test, 10 * 20);
    for (const actor of Object.values(world.state.actors)) {
      if (!actor.crew || actor.passenger === true) continue;
      for (const item of [...stores.map((i) => i.id), ...freight]) {
        expect(
          actor.knowledge[`${item}/itemLocation`],
          `${actor.name} knows ${item}`,
        ).toBeDefined();
      }
    }
  });
});

describe("freight is loaded by hand and delivered to the bay (D63)", () => {
  it("carries the crates aboard from staging, delivers them to the bay, pays once, carts them in", () => {
    const test = dockWorkWorld();
    const { world } = test;
    const id = offerFreight(test);
    const crates = [...job(world, id).cargoItemIds];
    accept(test, id);
    setCourse(test);
    const carriedOnDock = new Set<string>();
    const watch = (w: World) => {
      for (const itemId of crates) {
        const location = w.state.items[itemId]?.location;
        expect(location?.kind).not.toBe("inExternalStore");
        if (location?.kind !== "carriedBy") continue;
        const carrier = w.state.actors[location.actorId];
        if (carrier !== undefined && isOnDock(w.content, w.state, carrier.location)) {
          carriedOnDock.add(itemId);
        }
      }
    };
    run(test, 1);
    expect(loadWork(world, id).map((p) => p.status)).toEqual(["open", "open", "open"]);
    const loading = run(test, 6 * MINUTE, (w) => w.state.travel.stage === "undocking", watch);
    expect(world.state.travel.stage).toBe("undocking");
    expect(carriedOnDock).toEqual(new Set(crates));
    for (const location of crateLocations(world, id)) {
      expect(location?.kind === "onDeck" && !isOnDock(world.content, world.state, location)).toBe(
        true,
      );
    }
    expect(loading.some((e) => e.type === "taskCompleted" && e.payload.haul?.to === "ship")).toBe(
      true,
    );

    const delivery = run(test, 10 * MINUTE, (w) =>
      crates.every((itemId) => w.state.items[itemId]?.location.kind === "inExternalStore"),
    );
    expect(job(world, id).status).toBe("paid");
    // Each crate was carried ashore by hand to the bay (custody there completes the haul).
    const ashore = delivery.filter(
      (e) => e.type === "taskCompleted" && e.payload.haul?.to === "port",
    );
    expect(ashore).toHaveLength(3);
    const pays = delivery.filter((e) => e.type === "paymentMade" && e.payload.jobId === id);
    expect(pays).toHaveLength(1);
    // Every crate went through the bay: carted from there into the warehouse store.
    const carted = delivery.filter((e) => e.type === "cargoTransferred");
    expect(carted).toHaveLength(3);
    for (const e of carted) {
      if (e.type !== "cargoTransferred") continue;
      expect(onTile(QUAY_WORK.bay, tileAt(e.payload.from))).toBe(true);
      expect(e.payload.to).toEqual({
        kind: "inExternalStore",
        portId: TINY.port2,
        storeKey: "warehouse",
      });
    }
    // Paid on the bay once the last crate was set down, and carted in straight after.
    const paidTick = pays[0]?.tick ?? -1;
    expect(paidTick).toBe(Math.max(...ashore.map((e) => e.tick)));
    expect(carted.every((e) => e.tick === paidTick)).toBe(true);
  });

  it("carts the delivered crates in when the last one set down ends the port call", () => {
    const test = dockWorkWorld();
    const { world } = test;
    const id = offerFreight(test);
    const crates = [...job(world, id).cargoItemIds];
    accept(test, id);
    setCourse(test);
    run(
      test,
      20 * MINUTE,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === TINY.port2,
    );
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: TINY.port2 });
    // Course home is set before unloading ends, so the port call ends with the last crate: travel
    // moves to departure prep that tick, before commerce pays and carts.
    setCourse(test, TINY.port);
    const events = run(test, 10 * MINUTE, (w) => w.state.travel.stage === "departing");
    expect(job(world, id).status).toBe("paid");
    const prep = events.find(
      (e) => e.type === "travelStageChanged" && e.payload.to === "preparingDeparture",
    );
    const paid = events.find((e) => e.type === "paymentMade" && e.payload.jobId === id);
    expect(prep?.tick).toBe(paid?.tick);
    expect(events.filter((e) => e.type === "leftOnDock")).toEqual([]);
    expect(events.filter((e) => e.type === "cargoTransferred")).toHaveLength(crates.length);
    for (const itemId of crates) {
      expect(world.state.items[itemId]?.location).toEqual({
        kind: "inExternalStore",
        portId: TINY.port2,
        storeKey: "warehouse",
      });
    }
  });

  it("keeps carrying a crate when a repair it cannot do (no parts anywhere) comes up", () => {
    const test = dockWorkWorld({ partsStock: 0 });
    const { world } = test;
    const id = offerFreight(test);
    const crates = new Set<string>(job(world, id).cargoItemIds);
    accept(test, id);
    const carrying = (w: World) =>
      Object.values(w.state.items).some(
        (item) => crates.has(item.id) && item.location.kind === "carriedBy",
      );
    run(test, 2 * MINUTE, carrying);
    expect(carrying(world)).toBe(true);
    // A fault whose repair consumes a part the ship does not have and the port does not sell.
    addEngineFault(world);
    const events = run(test, 30 * 20);
    expect(events.some((e) => e.type === "taskBlocked")).toBe(true);
    const loadTasks = new Set(
      Object.values(world.state.work.tasks)
        .filter((t) => t.type === "haul")
        .map((t) => t.id),
    );
    const dropped = events.filter(
      (e) =>
        e.type === "taskReleased" &&
        e.payload.reason === "interrupted" &&
        loadTasks.has(e.payload.taskId),
    );
    expect(dropped).toEqual([]);
  });

  it("does not leave while accepted freight lies on the dock, even with its load work gone", () => {
    const test = dockWorkWorld();
    const { world } = test;
    const id = offerFreight(test);
    accept(test, id);
    run(test, 1);
    // The load work is lost (as if a save dropped it): the crates on the dock still hold the ship.
    for (const problem of loadWork(world, id)) problem.status = "resolved";
    setCourse(test);
    run(test, 20 * 20);
    expect(world.state.travel.stage).toBe("docked");
    const ramps = Object.values(world.state.doors).filter((d) => d.kind === "ramp");
    expect(ramps.every((d) => d.requestedState === "open")).toBe(true);
    // Once the crates are aboard, the departure goes ahead.
    for (const itemId of job(world, id).cargoItemIds) {
      const item = world.state.items[itemId];
      if (item === undefined) throw new Error("lost a crate");
      item.location = { kind: "onDeck", deckId: DECK12.deck, x: 10.5, y: 6.5 };
    }
    world.caches.dirty.inventory = true;
    run(test, 2 * MINUTE, (w) => w.state.travel.stage === "undocking");
    expect(world.state.travel.stage).toBe("undocking");
  });
});

describe("parts are bought on the dock (D63)", () => {
  const boughtParts = (world: World) =>
    Object.values(world.state.items).filter((i) => i.defId === PARTS);

  it("buys at the stall, takes the parts in hand and carries them aboard", () => {
    const test = dockWorkWorld();
    const { world } = test;
    const { problemId } = addEngineFault(world);
    let buyerAtStall = false;
    const events = run(
      test,
      3 * MINUTE,
      (w) => w.state.work.problems[problemId]?.status === "resolved",
      (w) => {
        const held = boughtParts(w).find((i) => i.location.kind === "carriedBy");
        if (held?.location.kind !== "carriedBy") return;
        const buyer = w.state.actors[held.location.actorId];
        const tile = buyer === undefined ? undefined : tileAt(buyer.location);
        if (tile !== undefined && onTile([QUAY_WORK.stallCounter], tile)) buyerAtStall = true;
      },
    );
    expect(events.some((e) => e.type === "partsBought")).toBe(true);
    expect(buyerAtStall).toBe(true);
    // Set down aboard at the top of the cargo ramp, then fitted.
    expect(
      events.some((e) => e.type === "faultRepaired"),
      "the repair used the part",
    ).toBe(true);
  });

  it("sets the leftover parts down when the repair is done, not carried off to bed (D69)", () => {
    // The verifier's 8x playthroughs held for repairs indefinitely: the last repairer kept the
    // ship's only stack of spares in hand through meals, sleep and rest, and every other repair
    // was blocked on an inaccessible supply.
    const test = dockWorkWorld();
    const { world } = test;
    const { problemId } = addEngineFault(world);
    // A stack bigger than the repair needs: the stall's one part, made three once bought.
    run(test, 3 * MINUTE, (w) => Object.values(w.state.items).some((i) => i.defId === PARTS));
    const stack = Object.values(world.state.items).find((i) => i.defId === PARTS);
    if (stack?.stacking !== "stack") throw new Error("no stack of parts bought");
    stack.count = 3;
    run(test, 3 * MINUTE, (w) => w.state.work.problems[problemId]?.status === "resolved");
    expect(world.state.work.problems[problemId]?.status).toBe("resolved");
    run(test, 20);
    const left = Object.values(world.state.items).filter(
      (i) => i.defId === PARTS && (i.stacking !== "stack" || i.count > 0),
    );
    expect(left.length).toBeGreaterThan(0);
    for (const item of left) {
      expect(item.location.kind, item.id).not.toBe("carriedBy");
      // And the whole crew heard where they were left, so the next repairer can fetch them.
      for (const actor of Object.values(world.state.actors)) {
        if (!actor.crew) continue;
        const fact = actor.knowledge[`${item.id}/itemLocation`];
        expect(fact?.factType === "itemLocation" && fact.value.location, actor.name).toEqual(
          item.location,
        );
      }
    }
  });

  it("sets the part down when the repairer gives up the repair, so someone else can fit it", () => {
    const test = dockWorkWorld();
    const { world } = test;
    const { problemId } = addEngineFault(world);
    const repairTask = () =>
      Object.values(world.state.work.tasks).find(
        (t) => t.problemId === problemId && t.type === "repair",
      );
    const repairerHolding = (w: World) => {
      const held = boughtParts(w).find((i) => i.location.kind === "carriedBy");
      if (held?.location.kind !== "carriedBy") return undefined;
      const actor = w.state.actors[held.location.actorId];
      const task = repairTask();
      return actor?.activity.kind === "task" && actor.activity.taskId === task?.id
        ? actor
        : undefined;
    };
    run(test, 3 * MINUTE, (w) => repairerHolding(w) !== undefined);
    const repairer = repairerHolding(world);
    if (repairer === undefined) throw new Error("nobody picked the part up for the repair");
    // Hunger past survival interrupts the repair.
    send(test, {
      source: "scenario",
      kind: "scenarioSetNeeds",
      payload: { actorId: repairer.id, needs: { hunger: 1 } },
    });
    run(test, 20, (w) => w.state.actors[repairer.id]?.activity.kind !== "task");
    expect(repairer.activity.kind === "task" && repairer.activity.taskId === repairTask()?.id).toBe(
      false,
    );
    const part = boughtParts(world)[0];
    expect(part?.location.kind).toBe("onDeck");
    run(test, 3 * MINUTE, (w) => w.state.work.problems[problemId]?.status === "resolved");
    expect(world.state.work.problems[problemId]?.status).toBe("resolved");
  });

  it("buys through the gate where the dock has no stall: off ship at the gate, back with the part", () => {
    const test = dockWorkWorld({ homeStall: false });
    const { world } = test;
    const { problemId } = addEngineFault(world);
    let outThroughGate: ActorId | undefined;
    let backAtGateCarrying = false;
    const events = run(
      test,
      3 * MINUTE,
      (w) => w.state.work.problems[problemId]?.status === "resolved",
      (w) => {
        for (const actor of Object.values(w.state.actors)) {
          if (actor.availability === "offShip" && actor.location.kind === "inExternalStore") {
            outThroughGate = actor.id;
            expect(actor.location).toMatchObject({ portId: TINY.port });
          }
        }
        const held = boughtParts(w).find((i) => i.location.kind === "carriedBy");
        if (held?.location.kind === "carriedBy" && held.location.actorId === outThroughGate) {
          const buyer = w.state.actors[held.location.actorId];
          if (onTile([QUAY_WORK.gate], tileAt(buyer?.location))) backAtGateCarrying = true;
        }
      },
    );
    expect(outThroughGate).toBeDefined();
    expect(backAtGateCarrying).toBe(true);
    expect(events.some((e) => e.type === "partsBought")).toBe(true);
    expect(events.some((e) => e.type === "faultRepaired")).toBe(true);
  });
});

describe("passengers come and go through the gate (D63)", () => {
  it("boards at the gate, walks aboard, and at the far port walks out through the gate", () => {
    const test = dockWorkWorld();
    const { world } = test;
    send(test, {
      source: "scenario",
      kind: "offerJob",
      payload: {
        job: {
          issuer: { name: "Ines Varga", role: "surveyor" },
          description: { key: "test.job", params: {} },
          fromPortId: TINY.port,
          toPortId: TINY.port2,
          cargo: [],
          pay: 90,
          passenger: true,
        },
        surface: false,
      },
    });
    run(test, 1);
    const [passage] = Object.values(world.state.jobs);
    if (passage === undefined) throw new Error("no passage offered");
    accept(test, passage.id);
    run(test, 1);
    const actorId = job(world, passage.id).passage?.actorId;
    if (actorId === undefined) throw new Error("no passenger");
    const passenger = () => world.state.actors[actorId];
    const startTile = tileAt(passenger()?.location);
    // Spawned at the gate, or a step from it after the first tick's walk.
    expect(startTile, JSON.stringify(passenger()?.location)).toBeDefined();
    expect(Math.abs((startTile?.x ?? 99) - QUAY_WORK.gate.x)).toBeLessThanOrEqual(1);
    run(test, MINUTE, (w) => {
      const p = w.state.actors[actorId];
      return p !== undefined && !isOnDock(w.content, w.state, p.location);
    });
    const aboard = passenger();
    expect(aboard !== undefined && !isOnDock(world.content, world.state, aboard.location)).toBe(
      true,
    );
    setCourse(test);
    let lastTile: ReturnType<typeof tileAt>;
    const events = run(
      test,
      10 * MINUTE,
      (w) => w.state.jobs[passage.id]?.passage?.endReason !== undefined,
      (w) => {
        const p = w.state.actors[actorId];
        if (p !== undefined) lastTile = tileAt(p.location);
      },
    );
    expect(job(world, passage.id).passage?.endReason).toBe("completed");
    // Seen last on the step before the gate: they reach it and leave in the same tick.
    const gap = Math.max(
      Math.abs((lastTile?.x ?? 99) - QUAY_WORK.gate.x),
      Math.abs((lastTile?.y ?? 99) - QUAY_WORK.gate.y),
    );
    expect(gap, JSON.stringify(lastTile)).toBeLessThanOrEqual(1);
    expect(events.some((e) => e.type === "passageEnded")).toBe(true);
  });
});

describe("a schema-3 save docked mid-loading (D63)", () => {
  it("has its freight moved from the warehouse store onto the staging area", () => {
    const test = dockWorkWorld();
    const { kernel, world } = test;
    const id = offerFreight(test);
    accept(test, id);
    run(test, 1);
    const envelope = kernel.serialize(world);
    const state = structuredClone(envelope.state);
    // biome-ignore lint/performance/noDelete: a schema-3 save has no such key.
    delete state.deck.dock;
    for (const itemId of state.jobs[id]?.cargoItemIds ?? []) {
      const item = state.items[itemId];
      if (item !== undefined) {
        item.location = { kind: "inExternalStore", portId: TINY.port, storeKey: "warehouse" };
      }
    }
    state.schemaVersion = 3;
    const restored = restoreThroughSchema6(
      { ...envelope, schemaVersion: 3, state },
      world.content,
      test.registry,
    );
    for (const itemId of job(restored, id).cargoItemIds) {
      const location = restored.state.items[itemId]?.location;
      if (location === undefined) throw new Error(`lost ${itemId}`);
      expect(isInDockArea(restored.content, restored.state, location, "freightStaging")).toBe(true);
    }
    // ... and loads from there.
    setCourse({ ...test, world: restored });
    run({ ...test, world: restored }, 6 * MINUTE, (w) => w.state.travel.stage === "undocking");
    expect(restored.state.travel.stage).toBe("undocking");
  });
});
