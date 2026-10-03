/**
 * Dockside spike: a dock grafted onto the deck's nav grid, joined at the ramps. See
 * docs/design/dockside-spike.md and fixtures/dock.ts for the layout.
 */
import { describe, expect, it } from "vitest";
import { configTicks } from "../../core/clock";
import { restore, serialize } from "../../core/save";
import type { TileCoord } from "../../core/types/common";
import type { MachineId } from "../../core/types/ids";
import { buildAgentView } from "../../view/agentView";
import { requestRamps } from "../travel/travel";
import { attachDock, detachDock, isOnDock, occupantsOfDock, rampLanding } from "./dock";
import { estimateTravelTicks, knownRoute } from "./estimates";
import { DECK12, JON, MARA, place } from "./fixtures/deck-12x8";
import { DOCK, dockedWorld, rampDeckWorld, rampIds, setRamps } from "./fixtures/dock";
import { stepChecked } from "./fixtures/helpers";
import {
  checkDockFitsDeck,
  compartmentAt,
  deckGeometry,
  dockFloorMask,
  doorBetween,
  hasWall,
  isDockFloor,
  isDockTile,
  isStaticFloor,
} from "./geometry";
import { spatialViolations } from "./invariants";
import { requestMove } from "./movement";
import { findPath } from "./pathfind";
import { holdsReservation } from "./reservations";
import { actorPolicy } from "./routing";

type Test = ReturnType<typeof dockedWorld>;

function actorOf(test: Test, id: typeof MARA) {
  const actor = test.world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

function tileOfActor(test: Test, id: typeof MARA): TileCoord {
  const location = actorOf(test, id).location;
  if (location.kind !== "onDeck") throw new Error(`${id} is not on deck`);
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

/** Put an actor on a tile (test setup), keeping deckId the ship's: dock tiles are deck tiles. */
function placeAt(test: Test, id: typeof MARA, tile: TileCoord): void {
  place(test.world, id, tile);
}

function walk(test: Test, id: typeof MARA, to: TileCoord, maxTicks = 600): number {
  const { world } = test;
  expect(requestMove(world.state, id, to, world.caches, world.config.values)).toBe(true);
  let ticks = 0;
  while (actorOf(test, id).movement.kind === "moving") {
    if (ticks++ >= maxTicks) throw new Error(`${id} still walking after ${maxTicks} ticks`);
    stepChecked(test, 1);
  }
  return ticks;
}

/** Ramps crossed by consecutive steps of a path. */
function rampsCrossed(test: Test, path: readonly TileCoord[]) {
  const geometry = deckGeometry(test.world.caches, DECK12.deck);
  const ramps = Object.values(rampIds(test.world));
  const crossed = [];
  for (let i = 1; i < path.length; i++) {
    const door = doorBetween(geometry, path[i - 1] as TileCoord, path[i] as TileCoord);
    if (door !== undefined && ramps.includes(door)) crossed.push(door);
  }
  return crossed;
}

describe("dock graft geometry", () => {
  it("grows the deck's grid to cover the dock, with dock floor in no compartment", () => {
    const test = rampDeckWorld();
    const bare = deckGeometry(test.world.caches, DECK12.deck);
    expect([bare.originX, bare.originY, bare.width, bare.height]).toEqual([0, 0, 12, 8]);
    expect(isDockTile(bare, DOCK.foreQuay.x, DOCK.foreQuay.y)).toBe(false);

    attachDock(test.world, { dockId: DOCK.id, deckId: DECK12.deck });
    const geometry = deckGeometry(test.world.caches, DECK12.deck);
    expect([geometry.originX, geometry.originY, geometry.width, geometry.height]).toEqual([
      -2, -1, 16, 12,
    ]);
    expect(isDockTile(geometry, -2, 3)).toBe(true);
    expect(isDockTile(geometry, 2, 7)).toBe(true);
    expect(isDockTile(geometry, 2, 6)).toBe(false); // the ship's corridor
    expect(isDockTile(geometry, 6, 9)).toBe(false); // crate stack: not floor
    expect(compartmentAt(geometry, -1.5, 3.5)).toBeUndefined();
    expect(compartmentAt(geometry, 0.5, 5.5)).toBeDefined();
    const ramps = rampIds(test.world);
    expect(rampLanding(geometry, ramps.cargo)).toEqual(DOCK.cargoLanding);
    expect(rampLanding(geometry, ramps.personnel)).toEqual(DOCK.personnelLanding);
    expect(test.world.state.deck.dock).toEqual({ dockId: DOCK.id, deckId: DECK12.deck });
  });

  it("walls the dock off from the ship except at the ramps", () => {
    const test = dockedWorld();
    const geometry = deckGeometry(test.world.caches, DECK12.deck);
    const everyDoorOpen = { doorCost: () => 0, tileBlocked: () => false };
    // Even treating every door as open, the only way between quay and ship is a ramp door.
    const path = findPath(geometry, DOCK.foreQuay, { x: 0, y: 5 }, everyDoorOpen) ?? [];
    expect(path.length).toBeGreaterThan(0);
    expect(rampsCrossed(test, path)).toHaveLength(1);
    // Exhaustively: every edge between ship floor and dock floor is walled on both tiles, except
    // the two ramp edges, which are doors.
    const ramps = Object.values(rampIds(test.world));
    const sides = [
      ["e", "w", 1, 0],
      ["s", "n", 0, 1],
    ] as const;
    let hullEdges = 0;
    let rampEdges = 0;
    for (let y = geometry.originY; y < geometry.originY + geometry.height; y++) {
      for (let x = geometry.originX; x < geometry.originX + geometry.width; x++) {
        for (const [side, back, dx, dy] of sides) {
          const a = { x, y };
          const b = { x: x + dx, y: y + dy };
          const floorA = isStaticFloor(geometry, a.x, a.y);
          const floorB = isStaticFloor(geometry, b.x, b.y);
          if (!floorA || !floorB) continue;
          if (isDockTile(geometry, a.x, a.y) === isDockTile(geometry, b.x, b.y)) continue;
          const door = doorBetween(geometry, a, b);
          if (door !== undefined) {
            expect(ramps).toContain(door);
            rampEdges += 1;
          } else {
            expect(hasWall(geometry, a, side) && hasWall(geometry, b, back)).toBe(true);
            hullEdges += 1;
          }
        }
      }
    }
    expect(rampEdges).toBe(2);
    expect(hullEdges).toBe(7 + 10); // west hull rows 0–6, south hull under the corridor
  });

  it("refuses a dock whose floor overlaps the ship or whose ramps land on nothing", () => {
    const test = rampDeckWorld();
    const docks = test.world.content.docks ?? {};
    const quay = docks[DOCK.id];
    if (quay === undefined) throw new Error("fixture lost the quay");
    const overlapping = { ...quay, rows: quay.rows.map((r, y) => (y === 3 ? ".".repeat(16) : r)) };
    const blind = { ...quay, rows: quay.rows.map((r, y) => (y === 8 ? "#".repeat(16) : r)) };
    const revision = test.world.state.deck.geometryRevision;
    for (const [layout, message] of [
      [overlapping, /overlaps deck/],
      [blind, /ramp "cargoRamp" does not open onto dock floor/],
    ] as const) {
      const content = { ...test.world.content, docks: { [DOCK.id]: layout } };
      const world = { ...test.world, content };
      expect(() => attachDock(world, { dockId: DOCK.id, deckId: DECK12.deck })).toThrow(message);
      // Nothing changed: no dock in state, same revision, bare grid.
      expect(test.world.state.deck.dock).toBeUndefined();
      expect(test.world.state.deck.geometryRevision).toBe(revision);
      expect(deckGeometry(test.world.caches, DECK12.deck).width).toBe(12);
    }
  });

  it("treats a tile under a blocking prop as no floor, and one under a passable prop as floor", () => {
    const test = dockedWorld();
    const geometry = deckGeometry(test.world.caches, DECK12.deck);
    const quay = test.world.content.docks?.[DOCK.id];
    if (quay === undefined) throw new Error("fixture lost the quay");
    // The crate stack covers dock (6..8, 10): deck (4..6, 9).
    expect(isDockFloor(quay, 7, 10)).toBe(false);
    expect(isDockTile(geometry, 5, 9)).toBe(false);
    expect(isDockTile(geometry, 7, 9)).toBe(true);
    const lamp = {
      ...quay,
      props: quay.props.map((p) => ({ ...p, blocking: false })),
    };
    expect(isDockFloor(lamp, 7, 10)).toBe(true);
    expect(dockFloorMask(lamp)[10 * quay.width + 7]).toBe(1);
  });

  it("checks a dock against a bare deck def, with no world, as content validation does", () => {
    const content = rampDeckWorld().world.content;
    expect(() => checkDockFitsDeck(content, DECK12.deck, DOCK.id)).not.toThrow();
    const quay = content.docks?.[DOCK.id];
    if (quay === undefined) throw new Error("fixture lost the quay");
    const blind = { ...quay, rows: quay.rows.map((r, y) => (y === 8 ? "#".repeat(16) : r)) };
    expect(() =>
      checkDockFitsDeck({ ...content, docks: { [DOCK.id]: blind } }, DECK12.deck, DOCK.id),
    ).toThrow(/ramp "cargoRamp" does not open onto dock floor/);
  });
});

describe("crossing the ramps", () => {
  it("a closed ramp cuts the dock off for planning, estimates and movement", () => {
    const test = dockedWorld();
    const { world } = test;
    const config = world.config.values;
    placeAt(test, MARA, { x: 2, y: 5 });
    const geometry = deckGeometry(world.caches, DECK12.deck);
    const mara = actorOf(test, MARA);
    expect(
      findPath(
        geometry,
        { x: 2, y: 5 },
        DOCK.cargoLanding,
        actorPolicy(world.state, geometry, mara, config),
      ),
    ).toBeNull();
    expect(estimateTravelTicks(geometry, { x: 2, y: 5 }, DOCK.cargoLanding, config)).toBeNull();
    expect(requestMove(world.state, MARA, DOCK.cargoLanding, world.caches, config)).toBe(false);
  });

  it("stops routing down a ramp the moment travel asks for it up, while it is still open", () => {
    const test = dockedWorld();
    const { world } = test;
    const config = world.config.values;
    setRamps(test, "open");
    const geometry = deckGeometry(world.caches, DECK12.deck);
    expect(estimateTravelTicks(geometry, { x: 2, y: 5 }, DOCK.cargoLanding, config)).not.toBeNull();
    requestRamps(world, "closed");
    expect(world.state.doors[rampIds(world).cargo]?.physicalState).toBe("open");
    expect(estimateTravelTicks(geometry, { x: 2, y: 5 }, DOCK.cargoLanding, config)).toBeNull();
    placeAt(test, MARA, { x: 2, y: 5 });
    expect(requestMove(world.state, MARA, DOCK.cargoLanding, world.caches, config)).toBe(false);
    expect(spatialViolations(world)).toEqual([]);
  });

  it("a ramp that is still lowering is not passable yet", () => {
    const test = dockedWorld();
    const { world } = test;
    const config = world.config.values;
    const { cargo, personnel } = rampIds(world);
    for (const id of [cargo, personnel]) {
      const door = world.state.doors[id];
      if (door !== undefined) door.requestedState = "open";
    }
    stepChecked(test, 3);
    expect(world.state.doors[cargo]?.physicalState).toBe("opening");
    const geometry = deckGeometry(world.caches, DECK12.deck);
    expect(estimateTravelTicks(geometry, { x: 2, y: 5 }, DOCK.cargoLanding, config)).toBeNull();
    const revision = world.state.deck.geometryRevision;
    setRamps(test, "open");
    // Opening bumped the revision (cached routes dropped) and planning sees it immediately.
    expect(world.state.deck.geometryRevision).toBeGreaterThan(revision);
    expect(geometry.openRamps.has(cargo)).toBe(true);
    expect(estimateTravelTicks(geometry, { x: 2, y: 5 }, DOCK.cargoLanding, config)).toBe(
      configTicks(config, 2 / config.movement.walkSpeed),
    );
  });

  it("walks from the deck, down an open ramp, to the far end of the dock and back", () => {
    const test = dockedWorld();
    const { world } = test;
    setRamps(test, "open");
    placeAt(test, MARA, { x: 1, y: 2 }); // room A, behind manual door A
    const geometry = deckGeometry(world.caches, DECK12.deck);
    const route = knownRoute(geometry, { x: 1, y: 2 }, DOCK.foreQuay, world.config.values) ?? [];
    expect(rampsCrossed(test, route)).toHaveLength(1);

    walk(test, MARA, DOCK.foreQuay);
    const location = actorOf(test, MARA).location;
    // Well-formed: an ordinary on-deck position on the ship's deck, in negative deck x.
    expect(location).toEqual({ kind: "onDeck", deckId: DECK12.deck, x: -1.5, y: 3.5 });
    expect(isDockTile(geometry, location.kind === "onDeck" ? location.x : 0, 3.5)).toBe(true);
    expect(occupantsOfDock(world)).toEqual([`actor:${MARA}`]);
    expect(isOnDock(world.content, world.state, location)).toBe(true);
    expect(Object.values(world.caches.index.actorsByCompartment).flat()).not.toContain(MARA);

    walk(test, MARA, DOCK.farQuay);
    expect(tileOfActor(test, MARA)).toEqual(DOCK.farQuay);
    walk(test, MARA, { x: 11, y: 6 });
    expect(tileOfActor(test, MARA)).toEqual({ x: 11, y: 6 });
    expect(occupantsOfDock(world)).toEqual([]);
    expect(isOnDock(world.content, world.state, actorOf(test, MARA).location)).toBe(false);
  });

  it("estimates the cross-ramp walk as the walk actually takes, for spatial and the AgentView", () => {
    const test = dockedWorld();
    const { world } = test;
    const config = world.config.values;
    setRamps(test, "open");
    placeAt(test, JON, { x: 11, y: 6 });
    const geometry = deckGeometry(world.caches, DECK12.deck);
    const estimate = estimateTravelTicks(geometry, { x: 11, y: 6 }, DOCK.farQuay, config);
    expect(estimate).not.toBeNull();
    const view = buildAgentView(world, JON);
    expect(view.estimateTravelTicks(DOCK.farQuay)).toBe(estimate);
    expect(view.schematic.isFloor(DOCK.farQuay)).toBe(true);
    expect(view.schematic.compartmentAt(DOCK.farQuay)).toBeUndefined();
    const took = walk(test, JON, DOCK.farQuay);
    expect(Math.abs(took - (estimate ?? 0))).toBeLessThanOrEqual(2);
  });

  it("two people pass each other on one ramp without deadlock", () => {
    const test = dockedWorld();
    const { world } = test;
    const config = world.config.values;
    setRamps(test, "open");
    placeAt(test, MARA, { x: 2, y: 5 });
    placeAt(test, JON, { x: 2, y: 8 });
    // Straight down and straight up through the cargo ramp, in opposite directions at once.
    expect(requestMove(world.state, MARA, { x: 2, y: 9 }, world.caches, config)).toBe(true);
    expect(requestMove(world.state, JON, { x: 2, y: 5 }, world.caches, config)).toBe(true);
    for (const id of [MARA, JON]) {
      const m = actorOf(test, id).movement;
      expect(m.kind === "moving" && rampsCrossed(test, m.path)).toEqual([rampIds(world).cargo]);
    }
    let slowed = false;
    stepChecked(test, 200, () => {
      for (const id of [MARA, JON]) {
        const m = actorOf(test, id).movement;
        if (m.kind === "moving" && m.effectiveSpeed < config.movement.walkSpeed - 1e-9)
          slowed = true;
      }
    });
    expect(tileOfActor(test, MARA)).toEqual({ x: 2, y: 9 });
    expect(tileOfActor(test, JON)).toEqual({ x: 2, y: 5 });
    expect(slowed).toBe(true);
  });

  it("a deck interaction position reserved by someone aboard holds off a walker from the dock", () => {
    const test = dockedWorld();
    const { world } = test;
    const config = world.config.values;
    setRamps(test, "open");
    const pump = Object.values(world.state.machines).find((m) => m.placementKey === "pump1");
    const target = { machineId: pump?.id as MachineId, positionKey: "front" };
    placeAt(test, JON, { x: 9, y: 2 });
    expect(requestMove(world.state, JON, target, world.caches, config)).toBe(true);
    placeAt(test, MARA, DOCK.farQuay);
    expect(requestMove(world.state, MARA, target, world.caches, config)).toBe(true);
    expect(holdsReservation(world.caches, DECK12.deck, { x: 9, y: 1 }, JON)).toBe(true);
    stepChecked(test, 400);
    const mara = actorOf(test, MARA);
    expect(tileOfActor(test, JON)).toEqual({ x: 9, y: 1 });
    expect(mara.movement).toMatchObject({
      kind: "stationary",
      routeFailure: { reason: "positionTaken" },
    });
    // She came aboard and waited next to the position, not on the dock.
    expect(
      isDockTile(
        deckGeometry(world.caches, DECK12.deck),
        tileOfActor(test, MARA).x,
        tileOfActor(test, MARA).y,
      ),
    ).toBe(false);
  });

  it("a ramp raised before someone reaches it ends their route; it is never reopened for them", () => {
    const test = dockedWorld();
    const { world } = test;
    setRamps(test, "open");
    placeAt(test, MARA, DOCK.foreQuay);
    expect(requestMove(world.state, MARA, { x: 11, y: 6 }, world.caches, world.config.values)).toBe(
      true,
    );
    const { cargo, personnel } = rampIds(world);
    for (const id of [cargo, personnel]) {
      const door = world.state.doors[id];
      if (door !== undefined) door.requestedState = "closed";
    }
    const events = stepChecked(test, 300);
    expect(world.state.doors[cargo]?.physicalState).toBe("closed");
    expect(world.state.doors[cargo]?.requestedState).toBe("closed");
    const mara = actorOf(test, MARA);
    expect(mara.movement).toMatchObject({
      kind: "stationary",
      routeFailure: { reason: "blocked" },
    });
    expect(events.some((e) => e.type === "routeBlocked")).toBe(true);
    expect(
      isDockTile(
        deckGeometry(world.caches, DECK12.deck),
        tileOfActor(test, MARA).x,
        tileOfActor(test, MARA).y,
      ),
    ).toBe(true);
  });

  it("a ramp told to close while someone is on it waits for them to clear it", () => {
    const test = dockedWorld();
    const { world } = test;
    setRamps(test, "open");
    placeAt(test, MARA, DOCK.cargoLanding);
    expect(requestMove(world.state, MARA, { x: 2, y: 5 }, world.caches, world.config.values)).toBe(
      true,
    );
    stepChecked(test, 2); // mid-aperture
    const cargo = rampIds(world).cargo;
    const door = world.state.doors[cargo];
    if (door === undefined) throw new Error("no cargo ramp");
    expect(door.occupants).toEqual([MARA]);
    door.requestedState = "closed";
    stepChecked(test, 1);
    expect(door.physicalState).toBe("open");
    // Someone in the aperture holds the ramp down, and a lowered ramp holds the dock.
    expect(() => detachDock(world)).toThrow(/ramps not closed: cargoRamp/);
    stepChecked(test, 100);
    expect(tileOfActor(test, MARA)).toEqual({ x: 2, y: 5 });
    expect(door.physicalState).toBe("closed");
  });
});

describe("dock lifetime", () => {
  it("refuses to take the dock away from under someone, then shrinks the grid back", () => {
    const test = dockedWorld();
    const { world } = test;
    setRamps(test, "open");
    placeAt(test, MARA, { x: 2, y: 5 });
    walk(test, MARA, DOCK.farQuay);
    expect(() => detachDock(world)).toThrow(/ramps not closed: cargoRamp, personnelRamp/);
    setRamps(test, "closed");
    expect(() => detachDock(world)).toThrow(/still on it: actor:a1/);
    expect(() => attachDock(world, { dockId: DOCK.id, deckId: DECK12.deck })).toThrow(
      /already alongside/,
    );
    setRamps(test, "open");
    walk(test, MARA, { x: 2, y: 5 });
    setRamps(test, "closed");
    detachDock(world);
    const geometry = deckGeometry(world.caches, DECK12.deck);
    expect([geometry.originX, geometry.originY, geometry.width, geometry.height]).toEqual([
      0, 0, 12, 8,
    ]);
    expect(geometry.dock).toBeUndefined();
    expect(world.state.deck.dock).toBeUndefined();
    expect(spatialViolations(world)).toEqual([]);
  });

  it("keeps per-tile state on dock tiles (negative coordinates) and drops it with the dock", () => {
    const test = dockedWorld();
    const { world } = test;
    const config = world.config.values;
    setRamps(test, "open");
    const geometry = () => deckGeometry(world.caches, DECK12.deck);
    const before = estimateTravelTicks(geometry(), DOCK.cargoLanding, DOCK.foreQuay, config);
    // Block the quay's west column below the ship, so the walk fore has to go round.
    const tiles = world.state.deck.tiles[DECK12.deck] ?? {};
    tiles["-1,7"] = { obstructed: true, floorIntegrity: 1 };
    tiles["-2,7"] = { obstructed: true, floorIntegrity: 1 };
    world.state.deck.geometryRevision += 1;
    stepChecked(test, 1);
    expect(estimateTravelTicks(geometry(), DOCK.cargoLanding, DOCK.foreQuay, config)).toBe(before);
    placeAt(test, MARA, DOCK.cargoLanding);
    expect(requestMove(world.state, MARA, DOCK.foreQuay, world.caches, config)).toBe(false);
    placeAt(test, MARA, { x: 2, y: 5 });
    setRamps(test, "closed");
    detachDock(world);
    expect(Object.keys(world.state.deck.tiles[DECK12.deck] ?? {})).toEqual([]);
  });

  it("nav refresh regrafts if state names a dock the grid lacks", () => {
    const test = rampDeckWorld();
    const { world } = test;
    // Bypass attachDock, as a migration writing state.deck.dock would.
    world.state.deck.dock = { dockId: DOCK.id, deckId: DECK12.deck };
    world.state.deck.geometryRevision += 1;
    stepChecked(test, 1);
    expect(deckGeometry(world.caches, DECK12.deck).dock?.dockId).toBe(DOCK.id);
  });

  it("refuses to restore a docked save whose dock layout is gone from content", () => {
    const test = dockedWorld();
    const blob = JSON.parse(JSON.stringify(serialize(test.world)));
    const content = { ...test.world.content, docks: {} };
    expect(() => restore(blob, content, test.registry)).toThrow(/No dock layout "dock.test.quay"/);
  });

  it("saves and restores mid-walk on the dock and carries on in lockstep", () => {
    const test = dockedWorld();
    const { world, registry, kernel } = test;
    setRamps(test, "open");
    placeAt(test, MARA, { x: 1, y: 6 });
    placeAt(test, JON, DOCK.foreQuay);
    requestMove(world.state, MARA, DOCK.farQuay, world.caches, world.config.values);
    requestMove(world.state, JON, { x: 10, y: 6 }, world.caches, world.config.values);
    stepChecked(test, 23);

    const blob = JSON.parse(JSON.stringify(serialize(world)));
    const restored = restore(blob, world.content, registry);
    expect(restored.state.deck.dock).toEqual(world.state.deck.dock);
    const geometry = deckGeometry(restored.caches, DECK12.deck);
    expect(geometry.dock?.dockId).toBe(DOCK.id);
    expect(geometry.openRamps.size).toBe(2);
    expect(restored.caches.nav.reservations).toEqual(world.caches.nav.reservations);
    for (let i = 0; i < 300; i++) {
      kernel.advance(world, 1);
      kernel.advance(restored, 1);
      expect(restored.state.actors[MARA]?.location).toEqual(world.state.actors[MARA]?.location);
      expect(restored.state.actors[JON]?.location).toEqual(world.state.actors[JON]?.location);
    }
    expect(restored.state).toStrictEqual(world.state);
    expect(tileOfActor(test, MARA)).toEqual(DOCK.farQuay);
    expect(tileOfActor(test, JON)).toEqual({ x: 10, y: 6 });
  });
});
