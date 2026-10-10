/** Room dirt, tiers with hysteresis, and deposits (§room-tiers). */
import { describe, expect, it } from "vitest";
import { FIXTURE_DIRT } from "../../core/fixtures/ship-life";
import type { TileCoord } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";
import type { DeckDefId } from "../../core/types/ids";
import { depositDirt } from "./deposit";
import { DIRT_DECK, cellAt, dirtContent, dirtWorld } from "./fixtures/dirt-deck";
import { dirtFloor, roomDirt, tierOf } from "./grid";

const config: Pick<ConfigDef, "dirt"> = { dirt: FIXTURE_DIRT };
const deck = dirtContent().decks[DIRT_DECK.deck];
if (deck === undefined) throw new Error("no dirt deck");
/** Room C, engineering: 20 cells (columns 8–11, rows 0–4), the pump and engine among them. */
const ENGINEERING = "roomC";

function engineeringCells(values: Record<string, number>): number[] {
  const cells = new Array<number>(12 * 8).fill(0);
  for (const [key, value] of Object.entries(values)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    cells[y * 12 + x] = value;
  }
  return cells;
}

describe("roomDirt (§room-tiers)", () => {
  it("is the mean, weighted towards the worst tile", () => {
    if (deck === undefined) throw new Error("no deck");
    // 20 cells in room C; one at 255 and the rest clean.
    const one = roomDirt(engineeringCells({ "8,0": 255 }), deck, ENGINEERING, config);
    expect(one).toBeCloseTo(0.7 * (1 / 20) + 0.3 * 1, 6);
    // The same total spread evenly reads much cleaner.
    const spread = roomDirt(
      engineeringCells(
        Object.fromEntries(
          [8, 9, 10, 11].flatMap((x) => [0, 1, 2, 3, 4].map((y) => [`${x},${y}`, 13])),
        ),
      ),
      deck,
      ENGINEERING,
      config,
    );
    expect(spread).toBeCloseTo(13 / 255, 6);
    expect(roomDirt(engineeringCells({}), deck, ENGINEERING, config)).toBe(0);
  });
});

describe("tierOf (§room-tiers)", () => {
  const { untidy, dirty, filthy } = FIXTURE_DIRT.tiers;
  const h = FIXTURE_DIRT.tierHysteresis;

  it("rises at each threshold", () => {
    expect(tierOf(untidy - 0.001, "clean", config)).toBe("clean");
    expect(tierOf(untidy, "clean", config)).toBe("untidy");
    expect(tierOf(dirty, "clean", config)).toBe("dirty");
    expect(tierOf(filthy, "untidy", config)).toBe("filthy");
  });

  it("falls only hysteresis below the stored tier's threshold, a tier at a time", () => {
    expect(tierOf(filthy - h + 0.001, "filthy", config)).toBe("filthy");
    expect(tierOf(filthy - h - 0.001, "filthy", config)).toBe("dirty");
    expect(tierOf(dirty - h + 0.001, "dirty", config)).toBe("dirty");
    expect(tierOf(dirty - h - 0.001, "dirty", config)).toBe("untidy");
    expect(tierOf(untidy - h - 0.001, "filthy", config)).toBe("clean");
    expect(tierOf(0, "dirty", config)).toBe("clean");
  });
});

describe("depositDirt (§dirt-deposits)", () => {
  it("lands round the machine on floor in its room, never under a machine or through a wall", () => {
    const test = dirtWorld({ bare: true });
    const { world } = test;
    // The engine stands at (11,3), in engineering; its neighbours (10,2)…(11,4) are room C.
    const origin: TileCoord = { x: 11, y: 3 };
    depositDirt(world.state, world.content, world.config.values, DIRT_DECK.deck, origin, 0.05);
    const floor = dirtFloor(world.content, deck);
    const around = [
      { x: 10, y: 2 },
      { x: 11, y: 2 },
      { x: 10, y: 3 },
      { x: 10, y: 4 },
      { x: 11, y: 4 },
    ];
    for (const t of around) expect(floor[t.y * 12 + t.x]).toBe(1);
    // 0.05 of 255 over five floor cells, rounded.
    for (const t of around) expect(cellAt(test, t)).toBe(Math.round((0.05 * 255) / 5));
    expect(cellAt(test, origin)).toBe(0);
    expect(world.state.dirt.cells[DIRT_DECK.deck]?.reduce((a, b) => a + b, 0)).toBe(15);
  });

  it("spreads evenly over the radius and clamps at 255", () => {
    const test = dirtWorld({ bare: true });
    const { world } = test;
    const centre = { x: 2, y: 2 }; // quarters, all floor round it
    depositDirt(world.state, world.content, world.config.values, DIRT_DECK.deck, centre, 9);
    expect(cellAt(test, centre)).toBe(255);
    expect(cellAt(test, { x: 3, y: 3 })).toBe(255);
    expect(cellAt(test, { x: 4, y: 2 })).toBe(0);
  });

  it("does nothing off the deck or for an unknown deck", () => {
    const test = dirtWorld({ bare: true });
    const { world } = test;
    depositDirt(world.state, world.content, world.config.values, DIRT_DECK.deck, { x: 2, y: 7 }, 1);
    depositDirt(
      world.state,
      world.content,
      world.config.values,
      "deck.none" as DeckDefId,
      { x: 0, y: 0 },
      1,
    );
    expect(Math.max(...(world.state.dirt.cells[DIRT_DECK.deck] ?? []))).toBe(0);
  });
});
