/**
 * Boots and dust (D82) on the dirt fixture: boots loaded on the quay shed a decaying trail from
 * the ramp into the hold; dust settles near the open ramp while docked, up to the visit cap, and
 * the count resets once the quay is gone; one docked visit of crew walking cargo leaves a trail.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { TileCoord } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import { detachDock } from "../spatial/dock";
import { rampIds, setRamps } from "../spatial/fixtures/dock";
import { stepChecked } from "../spatial/fixtures/helpers";
import { requestMove } from "../spatial/movement";
import {
  BETTINA,
  JON,
  MARA,
  RAMP_TOP,
  bringQuayAlongside,
  cellAt,
  cellsOf,
  dirtWorld,
  placeAt,
} from "./fixtures/dirt-deck";
import { dirtViolations } from "./invariants";

/** Off the quay's far end, deck frame (dock floor). */
const QUAY_FAR: TileCoord = { x: -1, y: 9 };
const HOLD_FAR: TileCoord = { x: 11, y: 6 };

/** Open only the cargo ramp (as travel would for loading), stepping until it is open. */
function openCargoRamp(test: TestWorld): void {
  const id = rampIds(test.world).cargo;
  const door = test.world.state.doors[id];
  if (door === undefined) throw new Error("no cargo ramp");
  door.requestedState = "open";
  for (let i = 0; i < 200 && door.physicalState !== "open"; i++) stepChecked(test, 1);
  if (door.physicalState !== "open") throw new Error("the cargo ramp never opened");
}

function step(test: TestWorld, ticks: number): void {
  stepChecked(test, ticks, () => {
    const violations = dirtViolations(test.world);
    if (violations.length > 0) throw new Error(violations.join("; "));
  });
}

/** Walk `actorId` to `to` and wait until they arrive, returning the deck tiles stepped on. */
function walk(test: TestWorld, actorId: ActorId, to: TileCoord): TileCoord[] {
  const { world } = test;
  if (!requestMove(world.state, actorId, to, world.caches, world.config.values)) {
    throw new Error(`cannot walk ${actorId} to ${to.x},${to.y}`);
  }
  const tiles: TileCoord[] = [];
  for (let i = 0; i < 2000; i++) {
    step(test, 1);
    const actor = world.state.actors[actorId];
    if (actor?.location.kind !== "onDeck") throw new Error("left the deck");
    const tile = { x: Math.floor(actor.location.x), y: Math.floor(actor.location.y) };
    const last = tiles[tiles.length - 1];
    if (last === undefined || last.x !== tile.x || last.y !== tile.y) tiles.push(tile);
    if (actor.movement.kind === "stationary") return tiles;
  }
  throw new Error("never arrived");
}

const onDeck = (t: TileCoord): boolean => t.x >= 0 && t.y >= 0 && t.y < 7;

describe("boots and the trail from the ramp (D82)", () => {
  it("boots loaded on the quay shed a decaying trail from the ramp into the hold", () => {
    const test = dirtWorld({ bare: true, dock: { airborneDust: 0 } });
    bringQuayAlongside(test);
    openCargoRamp(test);
    placeAt(test, JON, QUAY_FAR);
    walk(test, JON, { x: 2, y: 7 });
    const boots = test.world.state.actors[JON]?.boots ?? 0;
    expect(boots).toBeGreaterThan(0.15);
    const path = walk(test, JON, HOLD_FAR).filter(onDeck);
    expect(path[0]).toEqual(RAMP_TOP);
    const trail = path.map((t) => cellAt(test, t));
    // Each step sheds a share of what is left, so the trail fades along the walk.
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i]).toBeLessThanOrEqual(trail[i - 1] ?? 0);
    }
    expect(trail[0]).toBeGreaterThan(3 * (trail[trail.length - 1] ?? 0));
    expect(test.world.state.actors[JON]?.boots ?? 1).toBeLessThan(boots / 4);
  });

  it("a fixture dock graft with no grime loads nothing", () => {
    const test = dirtWorld({ bare: true, dock: { grime: 0, airborneDust: 0 } });
    bringQuayAlongside(test);
    openCargoRamp(test);
    placeAt(test, JON, QUAY_FAR);
    walk(test, JON, HOLD_FAR);
    expect(test.world.state.actors[JON]?.boots).toBeLessThan(0.01);
    expect(Math.max(...cellsOf(test))).toBe(1);
  });
});

describe("airborne dust (D82)", () => {
  it("settles near the open ramp while docked, stops at the visit cap, resets after undocking", () => {
    const test = dirtWorld({ bare: true });
    const config = test.world.config.values;
    const cap = config.dirt.airborneDustVisitCap;
    bringQuayAlongside(test);
    // Ramps shut: nothing settles.
    step(test, 200);
    expect(test.world.state.dirt.dustThisVisit).toBe(0);
    setRamps(test, "open");
    step(test, 200);
    const early = test.world.state.dirt.dustThisVisit;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(cap);
    // Nearer the ramp is dustier; past the radius nothing settles.
    expect(cellAt(test, RAMP_TOP)).toBeGreaterThan(cellAt(test, { x: 5, y: 2 }));
    expect(cellAt(test, { x: 6, y: 0 })).toBe(0);
    // The whole cap: airborneDust 1 × 0.5 a day reaches 0.3 in 0.6 of the fixture's 600 s day.
    const dayTicks = config.time.daySeconds * config.time.tickRate;
    step(test, Math.ceil(0.7 * dayTicks));
    expect(test.world.state.dirt.dustThisVisit).toBe(cap);
    const capped = [...cellsOf(test)];
    expect(cellAt(test, RAMP_TOP)).toBe(Math.round(cap * 255));
    step(test, 400);
    expect(cellsOf(test)).toEqual(capped);
    setRamps(test, "closed");
    detachDock(test.world);
    step(test, 40);
    expect(test.world.state.dirt.dustThisVisit).toBe(0);
  });
});

describe("one docked visit (D82 done-when)", () => {
  it("crew carrying from the quay into the hold leave a visible trail from the ramp", () => {
    const test = dirtWorld({ bare: true });
    bringQuayAlongside(test);
    openCargoRamp(test);
    const crew = [JON, BETTINA, MARA];
    for (let trip = 0; trip < 3; trip++) {
      for (const id of crew) {
        placeAt(test, id, QUAY_FAR);
        walk(test, id, HOLD_FAR);
      }
    }
    setRamps(test, "closed");
    detachDock(test.world);
    step(test, 40);
    // The lane east from the ramp's top along the hold's south row.
    const lane = [2, 3, 4, 5, 6, 7, 8, 9].map((x) => cellAt(test, { x, y: 6 }));
    for (const cell of lane) expect(cell).toBeGreaterThan(30);
    // A trail, not a wash: the row behind it, away from the lane, holds much less.
    expect(cellAt(test, { x: 9, y: 5 })).toBeLessThan((lane[7] ?? 0) / 2);
  });
});
