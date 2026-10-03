/**
 * D61: the dock alongside in the sim. Its lifetime follows travel (from the start of `docking` to
 * the end of `undocking`), departure prep keeps the ramps down and calls everyone on the dock
 * aboard (bringing up anyone who cannot come, so nothing holds a departure forever), the render
 * frame projects the dock and who is on it, and a schema-3 save gets its dock on load.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { actionLabel, getRenderFrame } from "../../core/render";
import type { TileCoord } from "../../core/types/common";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, DoorId, ItemId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { SCHEMA_VERSION } from "../../core/types/state";
import { DOCK } from "../spatial/fixtures/dock";
import { deckGeometry } from "../spatial/geometry";
import { spatialViolations } from "../spatial/invariants";
import { requestMove } from "../spatial/movement";
import { workViolations } from "../work/invariants";
import {
  FAR_DOCK,
  HOME_DOCK,
  ackHook,
  docksideConfig,
  docksideWorld,
  setCourse,
} from "./fixtures-dock";
import { travelViolations } from "./invariants";

const MARA = "a1" as ActorId;
const JON = "a2" as ActorId;
/** The cargo ramp's top (ship side), where a walk back aboard from the quay's middle ends. */
const CARGO_RAMP_TOP: TileCoord = { x: 2, y: 6 };

interface Log {
  readonly events: SimEvent[];
  readonly stages: string[];
  readonly docks: (string | undefined)[];
  readonly labels: Map<ActorId, Set<string>>;
  readonly headlines: Set<string>;
}

/** Step one tick at a time, acknowledging hooks, checking every invariant, recording the run. */
function run(test: TestWorld, ticks: number, until?: (world: World) => boolean): Log {
  const { kernel, world } = test;
  const log: Log = { events: [], stages: [], docks: [], labels: new Map(), headlines: new Set() };
  for (let i = 0; i < ticks; i++) {
    ackHook(test);
    const result = kernel.advance(world, 1);
    log.events.push(...result.events);
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...workViolations(world),
      ...travelViolations(world),
    ];
    if (violations.length > 0) {
      throw new Error(`tick ${world.state.tick}: ${violations.slice(0, 5).join("; ")}`);
    }
    log.stages.push(world.state.travel.stage);
    log.docks.push(world.state.deck.dock?.dockId);
    for (const actor of Object.values(world.state.actors)) {
      const set = log.labels.get(actor.id) ?? new Set<string>();
      set.add(actionLabel(actor, world.state, world.content));
      log.labels.set(actor.id, set);
    }
    log.headlines.add(getRenderFrame(world).headline);
    if (until?.(world)) break;
  }
  return log;
}

function actor(world: World, id: ActorId) {
  const found = world.state.actors[id];
  if (found === undefined) throw new Error(`no actor ${id}`);
  return found;
}

function place(world: World, id: ActorId, tile: TileCoord): void {
  const a = actor(world, id);
  a.movement = { kind: "stationary" };
  a.location = { kind: "onDeck", deckId: deckOf(world), x: tile.x + 0.5, y: tile.y + 0.5 };
}

function deckOf(world: World) {
  const presence = world.state.deck.dock;
  if (presence === undefined) throw new Error("no dock alongside");
  return presence.deckId;
}

function tileOf(world: World, id: ActorId): TileCoord {
  const location = actor(world, id).location;
  if (location.kind !== "onDeck") throw new Error(`${id} is not on deck`);
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

function ramps(world: World) {
  return Object.values(world.state.doors).filter((d) => d.kind === "ramp");
}

const ofType = <T extends SimEvent["type"]>(log: Log, type: T) =>
  log.events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

const departed = (world: World) => world.state.travel.stage === "departing";

describe("the dock's lifetime follows travel (D61)", () => {
  it("is alongside from the first tick at a port with a dock, ramps already down", () => {
    const { world } = docksideWorld();
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: TINY.port });
    expect(world.state.deck.dock).toEqual({ dockId: HOME_DOCK.id, deckId: deckOf(world) });
    expect(ramps(world).map((r) => [r.physicalState, r.requestedState])).toEqual([
      ["open", "open"],
      ["open", "open"],
    ]);
    expect(travelViolations(world)).toEqual([]);
  });

  it("comes alongside at the start of docking and leaves at the end of undocking", () => {
    const test = docksideWorld();
    setCourse(test, TINY.port2);
    const out = run(test, 2_000, (w) => w.state.travel.stage === "docked" && w.state.tick > 5);
    // Every tick: the dock is there exactly from docking to undocking (travelViolations, above).
    const at = (stage: string) => out.docks.filter((_, i) => out.stages[i] === stage);
    expect(new Set(at("preparingDeparture"))).toEqual(new Set([HOME_DOCK.id]));
    expect(new Set(at("undocking"))).toEqual(new Set([HOME_DOCK.id]));
    for (const stage of ["departing", "transit", "approaching"]) {
      expect(new Set(at(stage)), stage).toEqual(new Set([undefined]));
    }
    expect(new Set(at("docking"))).toEqual(new Set([FAR_DOCK.id]));
    expect(test.world.state.deck.dock?.dockId).toBe(FAR_DOCK.id);
    // The nav grid grafts the far quay now.
    const geometry = deckGeometry(test.world.caches, deckOf(test.world));
    expect(geometry.dock?.dockId).toBe(FAR_DOCK.id);
    // Docked, the ramps come down again.
    run(test, 100);
    expect(ramps(test.world).every((r) => r.physicalState === "open")).toBe(true);
  });

  it("stays away at a port without a dock map, which keeps the transfer tiles", () => {
    const test = docksideWorld();
    setCourse(test, TINY.port2);
    run(test, 2_000, (w) => w.state.travel.stage === "docked" && w.state.tick > 5);
    setCourse(test, TINY.port3);
    const out = run(test, 3_000, (w) => w.state.travel.stage === "docked");
    expect(test.world.state.travel).toMatchObject({ stage: "docked", portId: TINY.port3 });
    expect(test.world.state.deck.dock).toBeUndefined();
    expect(new Set(out.docks.filter((_, i) => out.stages[i] === "docking"))).toEqual(
      new Set([undefined]),
    );
    expect(getRenderFrame(test.world).dock).toBeUndefined();
  });
});

describe("departure waits for everyone on the dock (D61)", () => {
  it("keeps the ramps down and calls someone on the quay back aboard before leaving", () => {
    const test = docksideWorld();
    const { world } = test;
    place(world, MARA, DOCK.farQuay);
    setCourse(test, TINY.port2);
    const prep = run(test, 40, () => false);
    expect(world.state.travel.stage).toBe("preparingDeparture");
    // While she is out there the ramps stay requested down, and the stage clock does not run.
    expect(ramps(world).every((r) => r.requestedState === "open")).toBe(true);
    expect(
      world.state.travel.stage === "preparingDeparture" && world.state.travel.stageProgress,
    ).toBe(0);
    expect(prep.headlines).toContain(
      "Waiting for Mara Voss to come aboard — preparing to depart for Far Dock",
    );
    expect(prep.labels.get(MARA)).toContain("coming aboard");

    const rest = run(test, 1_000, departed);
    expect(world.state.travel.stage).toBe("departing");
    const aboard = [...prep.events, ...rest.events].filter(
      (e): e is Extract<SimEvent, { type: "cameAboard" }> =>
        e.type === "cameAboard" && e.subjectIds[0] === MARA,
    );
    expect(aboard).toHaveLength(1);
    expect(ofType(rest, "broughtAboard")).toEqual([]);
    expect(world.state.deck.dock).toBeUndefined();
    expect(tileOf(world, MARA)).toEqual(CARGO_RAMP_TOP);
  });

  it("calls back someone walking onto the dock when prep begins", () => {
    const test = docksideWorld();
    const { world } = test;
    place(world, JON, { x: 1, y: 6 });
    const walk = requestMove(world.state, JON, DOCK.foreQuay, world.caches, world.config.values);
    expect(walk).toBe(true);
    setCourse(test, TINY.port2);
    const out = run(test, 1_000, departed);
    expect(world.state.travel.stage).toBe("departing");
    expect(ofType(out, "broughtAboard")).toEqual([]);
    expect(tileOf(world, JON).y).toBeLessThanOrEqual(6);
  });

  it("brings up at once someone on the dock who cannot walk, and says so", () => {
    const test = docksideWorld();
    const { world } = test;
    place(world, MARA, DOCK.foreQuay);
    actor(world, MARA).availability = "incapacitated";
    setCourse(test, TINY.port2);
    const out = run(test, 1_000, departed);
    const brought = ofType(out, "broughtAboard");
    expect(brought.map((e) => e.payload)).toEqual([
      { actorId: MARA, name: "Mara Voss", portId: TINY.port },
    ]);
    // Brought up the nearest ramp (the cargo ramp is closer to the bow end of the quay).
    expect(brought[0]?.tick).toBeLessThan(5);
    expect(world.state.travel.stage).toBe("departing");
    expect(world.state.deck.dock).toBeUndefined();
  });

  it("brings up whoever is still out when the call runs out (travel.recallAboardSeconds)", () => {
    const test = docksideWorld(docksideConfig({ recallAboardSeconds: 1 }));
    const { world } = test;
    place(world, MARA, DOCK.foreQuay);
    setCourse(test, TINY.port2);
    const out = run(test, 1_000, departed);
    const brought = ofType(out, "broughtAboard");
    expect(brought).toHaveLength(1);
    const limit = world.config.values.time.tickRate * 1;
    expect(brought[0]?.tick).toBeGreaterThanOrEqual(limit);
    expect(brought[0]?.tick).toBeLessThan(limit + 5);
    expect(world.state.travel.stage).toBe("departing");
  });

  it("leaves anything still on the dock at the port's warehouse when the dock goes", () => {
    const test = docksideWorld();
    const { world } = test;
    const wrench = Object.values(world.state.items).find((i) => i.defId === TINY.wrench);
    if (wrench === undefined) throw new Error("fixture lost the wrench");
    wrench.location = { kind: "onDeck", deckId: deckOf(world), x: -1.5, y: 1.5 };
    setCourse(test, TINY.port2);
    const out = run(test, 1_000, departed);
    expect(ofType(out, "leftOnDock").map((e) => e.payload)).toEqual([
      { itemId: wrench.id as ItemId, portId: TINY.port },
    ]);
    expect(wrench.location).toEqual({
      kind: "inExternalStore",
      portId: TINY.port,
      storeKey: "warehouse",
    });
  });
});

describe("crossing a ramp (D61)", () => {
  it("emits wentAshore and cameAboard, and labels the walk by its direction", () => {
    const test = docksideWorld();
    const { world } = test;
    place(world, MARA, { x: 2, y: 5 });
    actor(world, MARA).pendingIntent = {
      kind: "personal",
      activity: "wander",
      tile: DOCK.farQuay,
      urgency: "essentialOperation",
      trace: { candidates: 0, chosenReason: "test", rejected: [] },
    };
    const out = run(test, 400, (w) => tileOf(w, MARA).y === DOCK.farQuay.y);
    expect(out.labels.get(MARA)).toContain("going ashore");
    const cargoRamp = ramps(world).find((r) => r.placementKey === "cargoRamp")?.id as DoorId;
    expect(ofType(out, "wentAshore").map((e) => [e.subjectIds[0], e.payload.rampId])).toEqual([
      [MARA, cargoRamp],
    ]);
    // On the dock she sees what lies there and who stands there (dock floor has no compartment).
    const frame = getRenderFrame(world);
    expect(frame.actors.find((a) => a.id === MARA)?.onDock).toBe(true);
    expect(frame.actors.find((a) => a.id === JON)?.onDock).toBe(false);
  });

  it("someone on the dock sees the dock: its items and people", () => {
    const test = docksideWorld();
    const { world } = test;
    place(world, MARA, DOCK.farQuay);
    place(world, JON, { x: 7, y: 9 });
    const wrench = Object.values(world.state.items).find((i) => i.defId === TINY.wrench);
    if (wrench === undefined) throw new Error("fixture lost the wrench");
    wrench.location = { kind: "onDeck", deckId: deckOf(world), x: 3.5, y: 9.5 };
    run(test, 40);
    const mara = actor(world, MARA);
    expect(mara.knowledge[`${wrench.id}/itemLocation`]).toMatchObject({ evidence: "direct" });
    expect(mara.knowledge[`${JON}/actorStatus`]).toMatchObject({ evidence: "direct" });
  });
});

describe("the render frame's dock (D61)", () => {
  it("names the dock alongside and flags who and what is on it", () => {
    const test = docksideWorld();
    const { world } = test;
    place(world, MARA, DOCK.farQuay);
    const wrench = Object.values(world.state.items).find((i) => i.defId === TINY.wrench);
    if (wrench === undefined) throw new Error("fixture lost the wrench");
    wrench.location = { kind: "onDeck", deckId: deckOf(world), x: -1.5, y: 2.5 };
    const frame = getRenderFrame(world);
    expect(frame.dock).toEqual({ dockId: HOME_DOCK.id, deckId: deckOf(world) });
    expect(frame.actors.find((a) => a.id === MARA)).toMatchObject({
      x: DOCK.farQuay.x + 0.5,
      y: DOCK.farQuay.y + 0.5,
      onDock: true,
    });
    expect(frame.actors.find((a) => a.id === JON)?.onDock).toBe(false);
    expect(frame.items.find((i) => i.id === wrench.id)?.location).toEqual({
      kind: "deck",
      deckId: deckOf(world),
      x: -1.5,
      y: 2.5,
      onDock: true,
    });
    const rations = frame.items.find((i) => i.defId === TINY.rations);
    expect(rations?.location).toMatchObject({ kind: "deck", onDock: false });
  });
});

describe("the travel invariant (D61)", () => {
  it("reports a dock alongside in flight and a missing dock while docked", () => {
    const { world } = docksideWorld();
    const presence = world.state.deck.dock;
    if (presence === undefined) throw new Error("no dock at the start port");
    // biome-ignore lint/performance/noDelete: the test removes the key as a bad save would.
    delete world.state.deck.dock;
    expect(travelViolations(world)).toEqual([
      `no dock alongside in stage docked; "${HOME_DOCK.id}" is due`,
    ]);
    world.state.deck.dock = presence;
    world.state.travel = {
      stage: "transit",
      fromPortId: TINY.port,
      toPortId: TINY.port2,
      stageProgress: 0,
      routeProgress: 0,
      routeDistance: 30,
      drifting: false,
      stageStartedTick: 0,
    };
    expect(travelViolations(world)).toEqual([
      `dock "${HOME_DOCK.id}" is alongside in stage transit with none due`,
    ]);
  });
});

describe("save migration 3 → 4 (D61)", () => {
  /** A schema-3 envelope of `world`: no `deck.dock`, ramps shut as they used to shut themselves. */
  function asSchema3(test: TestWorld) {
    const envelope = test.kernel.serialize(test.world);
    const state = structuredClone(envelope.state) as unknown as Record<string, never> & {
      deck: { dock?: unknown; geometryRevision: number };
      doors: Record<string, { kind: string; physicalState: string; requestedState: string }>;
      schemaVersion: number;
    };
    // biome-ignore lint/performance/noDelete: a schema-3 save has no such key.
    delete state.deck.dock;
    for (const door of Object.values(state.doors)) {
      if (door.kind !== "ramp") continue;
      door.physicalState = "closed";
      door.requestedState = "closed";
    }
    state.schemaVersion = 3;
    return { ...envelope, schemaVersion: 3, state: state as unknown as typeof envelope.state };
  }

  it("attaches the dock of the port a docked save is at, and lowers the ramps", () => {
    const test = docksideWorld();
    run(test, 10);
    const old = asSchema3(test);
    const revision = old.state.deck.geometryRevision;
    const restored = test.kernel.restore(old, test.world.content);
    expect(restored.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(restored.state.deck.dock).toEqual({
      dockId: HOME_DOCK.id,
      deckId: deckOf(test.world),
    });
    expect(restored.state.deck.geometryRevision).toBe(revision + 1);
    expect(deckGeometry(restored.caches, deckOf(test.world)).dock?.dockId).toBe(HOME_DOCK.id);
    const resumed: TestWorld = { ...test, world: restored };
    run(resumed, 100);
    expect(ramps(restored).every((r) => r.physicalState === "open")).toBe(true);
    // And it still leaves: the call, the ramps and the dock all work from the migrated save.
    setCourse(resumed, TINY.port2);
    run(resumed, 1_000, departed);
    expect(restored.state.deck.dock).toBeUndefined();
  });

  it("attaches the arriving port's dock to a save made mid-docking, and none in flight", () => {
    const test = docksideWorld();
    setCourse(test, TINY.port2);
    run(test, 2_000, (w) => w.state.travel.stage === "transit");
    const inFlight = test.kernel.restore(asSchema3(test), test.world.content);
    expect(inFlight.state.deck.dock).toBeUndefined();
    run(test, 2_000, (w) => w.state.travel.stage === "docking");
    const docking = test.kernel.restore(asSchema3(test), test.world.content);
    expect(docking.state.deck.dock?.dockId).toBe(FAR_DOCK.id);
    // Mid-docking the ramps stay up: only arriving lowers them.
    expect(ramps(docking).every((r) => r.requestedState === "closed")).toBe(true);
    expect(travelViolations(docking)).toEqual([]);
  });

  it("fills config keys an older save predates from the loaded content, with a warning", () => {
    const test = docksideWorld();
    const envelope = test.kernel.serialize(test.world);
    const config = structuredClone(envelope.config) as unknown as {
      travel: Record<string, unknown>;
    };
    // biome-ignore lint/performance/noDelete: the save predates the key.
    delete config.travel.recallAboardSeconds;
    const restored = test.kernel.restore(
      { ...envelope, config: config as unknown as typeof envelope.config },
      test.world.content,
    );
    expect(restored.config.values.travel.recallAboardSeconds).toBe(
      test.world.content.config.travel.recallAboardSeconds,
    );
    expect(restored.warnings.join("\n")).toContain("config.travel.recallAboardSeconds");
  });
});
