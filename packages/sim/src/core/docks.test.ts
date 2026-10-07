/**
 * D72: the ship's place in a dock's berth box. `berthPlacement` is the one rule every footprint
 * shares (flush to the box's south edge, the quay side, and centred across it); `berthDock`
 * carries that place with the map, and the frame conversions read it.
 */
import { describe, expect, it } from "vitest";
import {
  type BerthingDeck,
  berthDock,
  berthPlacement,
  deckToDock,
  dockToDeck,
  isDockFloorAt,
} from "./docks";
import type { DockDef, HullSizeClass } from "./types/content";
import type { DeckDefId, DockDefId, PortDefId } from "./types/ids";

type BerthDock = Pick<DockDef, "id" | "berth">;

function box(sizeClass: HullSizeClass, origin = { x: 2, y: 1 }): BerthDock {
  return { id: "dock.test.box" as DockDefId, berth: { origin, sizeClass } };
}

function deck(width: number, height: number, sizeClass: HullSizeClass): BerthingDeck {
  return {
    id: `deck.test.${width}x${height}` as DeckDefId,
    width,
    height,
    hull: { class: "test_hull", sizeClass, max: 100 },
  };
}

describe("berthPlacement", () => {
  it("puts a ship the size of the box exactly on the box", () => {
    expect(berthPlacement(box("M"), deck(36, 20, "M"))).toEqual({ x: 2, y: 1 });
    expect(berthPlacement(box("S", { x: 0, y: 0 }), deck(24, 14, "S"))).toEqual({ x: 0, y: 0 });
  });

  it("centres a smaller ship across the box and lays it flush to the south edge", () => {
    // M box 36×20 at (2,1): a 32×18 ship has 4 spare columns (2 each side) and 2 spare rows,
    // all above it, so its south hull is the box's bottom row (y = 1 + 20 − 1 = 20).
    const shipAt = berthPlacement(box("M"), deck(32, 18, "M"));
    expect(shipAt).toEqual({ x: 4, y: 3 });
    expect(shipAt.y + 18 - 1).toBe(1 + 20 - 1);
  });

  it("gives an odd spare column to the east side", () => {
    // 36 − 33 = 3 spare columns: one west, two east.
    const shipAt = berthPlacement(box("M"), deck(33, 20, "M"));
    expect(shipAt.x - 2).toBe(1);
    expect(2 + 36 - (shipAt.x + 33)).toBe(2);
  });

  it("takes a smaller class's ship in a larger class's box", () => {
    // An S ship (24×14) in an L box (40×24): 8 spare columns each side, 10 rows above.
    expect(berthPlacement(box("L", { x: 0, y: 0 }), deck(24, 14, "S"))).toEqual({ x: 8, y: 10 });
  });

  it("refuses a deck larger than its own size class", () => {
    expect(() => berthPlacement(box("L"), deck(37, 20, "M"))).toThrow(
      /Deck "deck.test.37x20" \(37 x 20\) exceeds its M box \(36 x 20\)/,
    );
    expect(() => berthPlacement(box("L"), deck(36, 21, "M"))).toThrow(/exceeds its M box/);
  });

  it("refuses a ship whose class is larger than the box's", () => {
    // The deck itself would fit the M box; its class says it may be up to 40×24, which does not.
    expect(() => berthPlacement(box("M"), deck(30, 18, "L"))).toThrow(
      /Dock "dock.test.box": a M berth cannot take "deck.test.30x18" \(class L\)/,
    );
    expect(() => berthPlacement(box("S"), deck(20, 10, "M"))).toThrow(/a S berth cannot take/);
  });
});

describe("berthDock and the frames", () => {
  const map: DockDef = {
    id: "dock.test.frames" as DockDefId,
    portId: "port.test.frames" as PortDefId,
    name: "Frames",
    palette: { floor: "#444444", wall: "#222222", accent: "#ffaa00" },
    width: 40,
    height: 23,
    berth: { origin: { x: 2, y: 1 }, sizeClass: "M" },
    legend: { ".": "floor", "#": "wall", " ": "void" },
    posts: [],
    areas: [],
    props: [],
    foreground: [],
    ambience: "A test quay.",
    grime: 0,
    airborneDust: 0,
    rows: [
      "#".repeat(40),
      ...Array.from({ length: 20 }, () => `..${" ".repeat(36)}..`),
      ".".repeat(40),
      ".".repeat(40),
    ],
  };
  const big = deck(36, 20, "M");
  const small = deck(32, 18, "M");

  it("memoizes one berthed dock per dock and deck", () => {
    expect(berthDock(map, big)).toBe(berthDock(map, big));
    expect(berthDock(map, small)).toBe(berthDock(map, small));
    expect(berthDock(map, big)).not.toBe(berthDock(map, small));
    expect(berthDock(map, big)).toEqual({ dock: map, shipAt: { x: 2, y: 1 } });
    expect(berthDock(map, small)).toEqual({ dock: map, shipAt: { x: 4, y: 3 } });
  });

  it("maps one dock tile to each ship's own deck frame, and back", () => {
    const quayTile = { x: 20, y: 21 };
    expect(dockToDeck(berthDock(map, big), quayTile)).toEqual({ x: 18, y: 20 });
    expect(dockToDeck(berthDock(map, small), quayTile)).toEqual({ x: 16, y: 18 });
    for (const ship of [big, small]) {
      const berth = berthDock(map, ship);
      expect(deckToDock(berth, dockToDeck(berth, quayTile))).toEqual(quayTile);
      // The tile just south of each ship's bottom row is the quay, in either frame.
      expect(isDockFloorAt(berth, { x: 0, y: ship.height })).toBe(true);
      expect(isDockFloorAt(berth, { x: 0, y: ship.height - 1 })).toBe(false);
    }
  });
});
