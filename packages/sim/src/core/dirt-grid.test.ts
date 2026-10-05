/** The dirt grid's index arithmetic (D82). */
import { describe, expect, it } from "vitest";
import { cellIndex, emptyCells, inGrid, roomCells } from "./dirt-grid";
import { TINY, tinyContent } from "./fixtures/tiny-content";

const deck = tinyContent().decks[TINY.deck];
if (deck === undefined) throw new Error("no tiny deck");

describe("dirt grid (D82)", () => {
  it("indexes row-major over the authored bounds", () => {
    expect(cellIndex(deck, { x: 0, y: 0 })).toBe(0);
    expect(cellIndex(deck, { x: 2, y: 1 })).toBe(deck.width + 2);
    expect(emptyCells(deck)).toEqual(new Array(deck.width * deck.height).fill(0));
  });

  it("knows the authored bounds (dock floor and fractions are outside)", () => {
    expect(inGrid(deck, { x: 0, y: 0 })).toBe(true);
    expect(inGrid(deck, { x: deck.width - 1, y: deck.height - 1 })).toBe(true);
    expect(inGrid(deck, { x: -1, y: 0 })).toBe(false);
    expect(inGrid(deck, { x: deck.width, y: 0 })).toBe(false);
    expect(inGrid(deck, { x: 0, y: deck.height })).toBe(false);
    expect(inGrid(deck, { x: 0.5, y: 0 })).toBe(false);
  });

  it("lists a room's cells by its symbol, cached, and none for an unknown key", () => {
    const [first] = deck.compartments;
    if (first === undefined) throw new Error("no room");
    const cells = roomCells(deck, first.key);
    const expected: number[] = [];
    deck.tiles.forEach((row, y) => {
      [...row].forEach((symbol, x) => {
        if (symbol === first.symbol) expected.push(y * deck.width + x);
      });
    });
    expect(cells).toEqual(expected);
    expect(cells.length).toBeGreaterThan(0);
    expect(roomCells(deck, first.key)).toBe(cells);
    expect(roomCells(deck, "nowhere")).toEqual([]);
  });
});
