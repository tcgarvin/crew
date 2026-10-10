/**
 * §berth-boxes: one dock, two footprints. The berth box takes a ship the size of the box and a
 * smaller one; the graft, the ramp landings, content validation's fit check, the dock's occupants
 * and its detaching all hold for both. See fixtures/berth-box.ts for the layout.
 */
import { describe, expect, it } from "vitest";
import { berthDock, deckToDock, dockToDeck } from "../../core/docks";
import { personnelRampFoot, waitingSpotByRamp } from "../../core/locals";
import type { TileCoord } from "../../core/types/common";
import type { DeckDef } from "../../core/types/content";
import type { DeckDefId } from "../../core/types/ids";
import { detachDock, occupantsOfDock, rampLanding } from "./dock";
import {
  BERTH_BOX,
  BERTH_BOX_DOCK,
  BIG,
  FOOTPRINTS,
  type Footprint,
  MARA,
  SMALL,
  berthBoxContent,
  berthBoxWorld,
  placeOn,
} from "./fixtures/berth-box";
import { rampIds, setRamps } from "./fixtures/dock";
import { stepChecked } from "./fixtures/helpers";
import {
  checkDockFitsDeck,
  deckGeometry,
  doorBetween,
  hasWall,
  isDockTile,
  isStaticFloor,
} from "./geometry";
import { spatialViolations } from "./invariants";
import { requestMove } from "./movement";

type Test = ReturnType<typeof berthBoxWorld>;

function deckOf(footprint: Footprint): DeckDef {
  const deck = berthBoxContent().decks[footprint.deckId];
  if (deck === undefined) throw new Error(`fixture lost ${footprint.deckId}`);
  return deck;
}

function tileOf(test: Test): TileCoord {
  const location = test.world.state.actors[MARA]?.location;
  if (location?.kind !== "onDeck") throw new Error("Mara is not on deck");
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

function walk(test: Test, to: TileCoord, maxTicks = 1500): void {
  const { world } = test;
  expect(requestMove(world.state, MARA, to, world.caches, world.config.values)).toBe(true);
  let ticks = 0;
  while (world.state.actors[MARA]?.movement.kind === "moving") {
    if (ticks++ >= maxTicks) throw new Error(`Mara still walking after ${maxTicks} ticks`);
    stepChecked(test, 1);
  }
  expect(tileOf(test)).toEqual(to);
}

describe("one berth box, two footprints", () => {
  it("lays each deck flush to the box's south edge and centred across it", () => {
    for (const footprint of FOOTPRINTS) {
      const berth = berthDock(BERTH_BOX_DOCK, deckOf(footprint));
      expect(berth.shipAt).toEqual(footprint.shipAt);
      // The ship's bottom row is the box's bottom row, whatever its height.
      expect(deckToDock(berth, { x: 0, y: footprint.height - 1 }).y).toBe(BERTH_BOX.quayRow - 1);
    }
    // The smaller ship is two columns in from each side of the 36-wide box.
    expect(SMALL.shipAt.x - BERTH_BOX.origin.x).toBe(2);
    expect(BERTH_BOX.origin.x + 36 - (SMALL.shipAt.x + SMALL.width)).toBe(2);
  });

  it.each(FOOTPRINTS)("lands both $name ramps on the first quay row", (footprint) => {
    const test = berthBoxWorld(footprint);
    const geometry = deckGeometry(test.world.caches, footprint.deckId);
    const ramps = rampIds(test.world);
    expect(rampLanding(geometry, ramps.cargo)).toEqual(footprint.cargoLanding);
    expect(rampLanding(geometry, ramps.personnel)).toEqual(footprint.personnelLanding);
    const berth = berthDock(BERTH_BOX_DOCK, deckOf(footprint));
    for (const landing of [footprint.cargoLanding, footprint.personnelLanding]) {
      expect(deckToDock(berth, landing).y).toBe(BERTH_BOX.quayRow);
      expect(isDockTile(geometry, landing.x, landing.y)).toBe(true);
    }
    // The grid covers the dock map around the ship: its origin is dock (0,0).
    expect([geometry.originX, geometry.originY, geometry.width, geometry.height]).toEqual([
      -footprint.shipAt.x,
      -footprint.shipAt.y,
      BERTH_BOX_DOCK.width,
      BERTH_BOX_DOCK.height,
    ]);
  });

  it.each(FOOTPRINTS)(
    "keeps dock floor off the $name ship and walls it off except at the ramps",
    (footprint) => {
      const test = berthBoxWorld(footprint);
      const geometry = deckGeometry(test.world.caches, footprint.deckId);
      // Every ship tile is ship floor, not dock floor.
      for (let y = 0; y < footprint.height; y++) {
        for (let x = 0; x < footprint.width; x++) {
          expect(isStaticFloor(geometry, x, y)).toBe(true);
          expect(isDockTile(geometry, x, y)).toBe(false);
        }
      }
      // Every edge between ship floor and dock floor is walled on both tiles, except the ramps.
      const ramps = Object.values(rampIds(test.world));
      const sides = [
        ["e", "w", 1, 0],
        ["s", "n", 0, 1],
      ] as const;
      let hullEdges = 0;
      const rampEdges: string[] = [];
      for (let y = geometry.originY; y < geometry.originY + geometry.height; y++) {
        for (let x = geometry.originX; x < geometry.originX + geometry.width; x++) {
          for (const [side, back, dx, dy] of sides) {
            const a = { x, y };
            const b = { x: x + dx, y: y + dy };
            if (!isStaticFloor(geometry, a.x, a.y) || !isStaticFloor(geometry, b.x, b.y)) continue;
            if (isDockTile(geometry, a.x, a.y) === isDockTile(geometry, b.x, b.y)) continue;
            const door = doorBetween(geometry, a, b);
            if (door === undefined) {
              expect(hasWall(geometry, a, side) && hasWall(geometry, b, back)).toBe(true);
              hullEdges += 1;
            } else {
              expect(ramps).toContain(door);
              rampEdges.push(door);
            }
          }
        }
      }
      expect(rampEdges.sort()).toEqual([...ramps].sort());
      expect(hullEdges).toBe(footprint.hullEdges);
    },
  );

  it("fits the dock to both decks with no world, as content validation does", () => {
    const content = berthBoxContent();
    for (const footprint of FOOTPRINTS) {
      expect(() => checkDockFitsDeck(content, footprint.deckId, BERTH_BOX.dock)).not.toThrow();
    }
    const big = deckOf(BIG);
    const large = {
      ...big,
      id: "deck.test.large" as DeckDefId,
      hull: { ...big.hull, sizeClass: "L" as const },
    };
    const oversize = { ...big, id: "deck.test.oversize" as DeckDefId, width: 37 };
    const withDecks = {
      ...content,
      decks: { ...content.decks, [large.id]: large, [oversize.id]: oversize },
    };
    expect(() => checkDockFitsDeck(withDecks, large.id, BERTH_BOX.dock)).toThrow(
      /a M berth cannot take "deck.test.large" \(class L\)/,
    );
    expect(() => checkDockFitsDeck(withDecks, oversize.id, BERTH_BOX.dock)).toThrow(
      /exceeds its M box/,
    );
  });

  it.each(FOOTPRINTS)(
    "holds the dock while anyone is on it and detaches back to the bare $name deck",
    (footprint) => {
      const test = berthBoxWorld(footprint);
      const { world } = test;
      const aboard = { x: 0, y: footprint.height - 1 };
      placeOn(world, footprint, MARA, aboard);
      setRamps(test, "open");
      walk(test, footprint.westMargin);
      const geometry = deckGeometry(world.caches, footprint.deckId);
      expect(isDockTile(geometry, footprint.westMargin.x, footprint.westMargin.y)).toBe(true);
      expect(occupantsOfDock(world)).toEqual([`actor:${MARA}`]);
      expect(() => detachDock(world)).toThrow(/ramps not closed: cargoRamp, personnelRamp/);
      setRamps(test, "closed");
      expect(() => detachDock(world)).toThrow(/still on it: actor:a1/);

      setRamps(test, "open");
      walk(test, aboard);
      expect(occupantsOfDock(world)).toEqual([]);
      setRamps(test, "closed");
      detachDock(world);
      const bare = deckGeometry(world.caches, footprint.deckId);
      expect([bare.originX, bare.originY, bare.width, bare.height]).toEqual([
        0,
        0,
        footprint.width,
        footprint.height,
      ]);
      expect(bare.dock).toBeUndefined();
      expect(world.state.deck.dock).toBeUndefined();
      expect(spatialViolations(world)).toEqual([]);
    },
  );
});

describe("the personnel ramp's foot with the smaller ship", () => {
  it("is the dock tile under the ramp, two columns east of the box origin's reckoning", () => {
    const test = berthBoxWorld(SMALL);
    const berth = berthDock(BERTH_BOX_DOCK, deckOf(SMALL));
    const foot = personnelRampFoot(test.world.content, SMALL.deckId, berth);
    expect(foot).toEqual(SMALL.personnelLanding);
    // Reckoned from the box's origin alone (as if the ship filled the box) the ramp column would
    // be dock x = 2 + 29; centring the 32-wide ship moves it two east.
    const naive = BERTH_BOX.origin.x + SMALL.personnelLanding.x;
    expect(deckToDock(berth, foot ?? { x: 0, y: 0 })).toEqual({
      x: naive + 2,
      y: BERTH_BOX.quayRow,
    });
    // The same dock tile in the big ship's frame is not its personnel landing.
    const bigBerth = berthDock(BERTH_BOX_DOCK, deckOf(BIG));
    expect(dockToDeck(bigBerth, deckToDock(berth, SMALL.personnelLanding))).not.toEqual(
      BIG.personnelLanding,
    );
  });

  it("puts someone waiting for the captain on free quay beside the foot, off the landing", () => {
    const test = berthBoxWorld(SMALL);
    const geometry = deckGeometry(test.world.caches, SMALL.deckId);
    const berth = berthDock(BERTH_BOX_DOCK, deckOf(SMALL));
    const spot = waitingSpotByRamp(test.world.state, test.world.content, SMALL.deckId, berth);
    if (spot === undefined) throw new Error("no waiting spot by the ramp");
    expect(spot).not.toEqual(SMALL.personnelLanding);
    expect(isDockTile(geometry, spot.x, spot.y)).toBe(true);
    const steps =
      Math.abs(spot.x - SMALL.personnelLanding.x) + Math.abs(spot.y - SMALL.personnelLanding.y);
    expect(steps).toBe(1);
    expect(deckToDock(berth, spot).y).toBeGreaterThanOrEqual(BERTH_BOX.quayRow);
  });
});
