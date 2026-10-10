import { describe, expect, it } from "vitest";
import type { BerthedDock } from "../../core/docks";
import type { TileCoord } from "../../core/types/common";
import type { DockDef } from "../../core/types/content";
import type { DockDefId, PortDefId } from "../../core/types/ids";
import { inCover, lineOfSight } from "./los";

/**
 * The Boathouse's rows 20–29 (`packages/content/data/docks/boathouse.json`, which the kernel's
 * tests cannot import), with the skiff and the barrels. Tiles below are in its dock frame; the
 * berth puts the ship at (4, 0), so the fight's deck frame is x − 4.
 */
const ROWS = [
  "............................................",
  "....................cc........cc............",
  "..........######.#########.#####............",
  "..........#....................#............",
  "..........#....................#............",
  "..........#..nn.......nn.......#............",
  "...............................#        ..  ",
  "..........#....................#        ..  ",
  "           #....................#        ..  ",
  "           ######################        ..  ",
];

const BOATHOUSE = {
  id: "dock.test.boathouse" as DockDefId,
  portId: "port.test.boathouse" as PortDefId,
  kind: "site",
  width: 44,
  height: 30,
  rows: [...Array.from({ length: 20 }, () => " ".repeat(44)), ...ROWS],
  legend: { ".": "floor", "#": "wall", " ": "void", c: "cover", n: "cover" },
  props: [
    { key: "skiff", kind: "hullSection", rect: { x: 33, y: 23, w: 3, h: 2 }, blocking: true },
    { key: "barrels", kind: "barrels", rect: { x: 12, y: 23, w: 2, h: 1 }, blocking: true },
  ],
} as unknown as DockDef;

const BERTH: BerthedDock = { dock: BOATHOUSE, shipAt: { x: 4, y: 0 } };

/** Dock-frame tile to the deck frame the fight runs in. */
const d = (x: number, y: number): TileCoord => ({ x: x - 4, y: y - 0 });
const sees = (a: TileCoord, b: TileCoord) => lineOfSight(BERTH, a, b);

describe("lines of sight on the Boathouse (call 8)", () => {
  it("sees through the east door and not through the shed's north wall", () => {
    expect(sees(d(26, 24), d(26, 20))).toBe(true);
    expect(sees(d(26, 20), d(26, 24))).toBe(true);
    expect(sees(d(21, 27), d(21, 20))).toBe(false);
    expect(sees(d(29, 24), d(29, 20))).toBe(false);
  });

  it("is symmetric and blocked by void and by walls", () => {
    for (const [a, b] of [
      [d(26, 24), d(30, 20)],
      [d(16, 24), d(38, 20)],
      [d(21, 27), d(41, 29)],
    ] as const) {
      expect(sees(a, b)).toBe(sees(b, a));
    }
    expect(sees(d(36, 25), d(41, 27))).toBe(false);
  });

  it("lets the net racks block from across the shed but not from beside them", () => {
    // Across: from two rows above the rack at (13,25) to two rows below it.
    expect(sees(d(13, 23), d(13, 27))).toBe(false);
    // Beside: from right above the rack, or right below it, the line passes.
    expect(sees(d(13, 24), d(13, 27))).toBe(true);
    expect(sees(d(13, 23), d(13, 26))).toBe(true);
  });

  it("gives cover behind the apron's crates against a shot from the shed door", () => {
    expect(inCover(BERTH, d(32, 21), d(26, 21))).toBe(true);
    expect(inCover(BERTH, d(32, 20), d(26, 20))).toBe(false);
    // The skiff covers someone east of it from the shed side.
    expect(inCover(BERTH, d(36, 24), d(32, 24))).toBe(true);
  });
});
