/**
 * §rock-impacts, §hull-scars-and-ship-loss: the hull as rocks see it. The footprint is every
 * authored tile of the deck (walls are edges, so none is excluded), a large rock's blast is its 3×3
 * clipped to the hull, and the bar is `max` less what the scars still cost.
 */
import { describe, expect, it } from "vitest";
import { FIELD, fieldConfig, fieldContent } from "../systems/field/fixtures/field-deck";
import {
  blastTiles,
  hullFootprint,
  inHullFootprint,
  integrityFromScars,
  scarDamageLeft,
  wholeHull,
} from "./hull";
import type { DeckDef } from "./types/content";
import type { CompartmentId, FieldId, ScarId } from "./types/ids";
import type { HullScar } from "./types/state";

function fieldDeck(): DeckDef {
  const deck = fieldContent(fieldConfig(), 9).decks[FIELD.deck];
  if (deck === undefined) throw new Error("no field deck");
  return deck;
}

/** The field deck with its corners cut away (void), as a hull with an irregular outline. */
function notchedDeck(): DeckDef {
  const deck = fieldDeck();
  const rows = deck.tiles.map((row, y) =>
    y === 0 || y === deck.tiles.length - 1 ? ` ${row.slice(1, -1)} ` : row,
  );
  return { ...deck, tiles: rows };
}

function scar(damage: number, recovered: number): HullScar {
  return {
    id: "r1" as ScarId,
    fieldId: "f1" as FieldId,
    tile: { x: 4, y: 2 },
    compartmentId: "c2" as CompartmentId,
    rock: "small",
    damage,
    recovered,
    patched: recovered > 0,
    tick: 0,
  };
}

describe("the hull footprint (slice 5 call 18)", () => {
  it("is every authored tile, machines and the tiles along the hull alike", () => {
    const deck = fieldDeck();
    const tiles = hullFootprint(deck);
    expect(tiles).toHaveLength(16 * 5);
    expect(tiles).toContainEqual({ x: 0, y: 0 });
    expect(tiles).toContainEqual({ x: 10, y: 2 }); // the engine's tile
    expect(tiles).toContainEqual({ x: 15, y: 4 });
  });

  it("leaves out void, and knows a tile off the deck is not hull", () => {
    const deck = notchedDeck();
    expect(hullFootprint(deck)).toHaveLength(16 * 5 - 4);
    expect(inHullFootprint(deck, 0, 0)).toBe(false);
    expect(inHullFootprint(deck, 1, 0)).toBe(true);
    expect(inHullFootprint(deck, 16, 2)).toBe(false);
    expect(inHullFootprint(deck, -1, 2)).toBe(false);
    expect(inHullFootprint(deck, 1.5, 2)).toBe(false);
  });
});

describe("a rock's blast (slice 5 call 6)", () => {
  it("is one tile for a small rock and nine for a large one inside the hull", () => {
    const deck = fieldDeck();
    expect(blastTiles(deck, { x: 5, y: 2 }, "small")).toEqual([{ x: 5, y: 2 }]);
    const large = blastTiles(deck, { x: 5, y: 2 }, "large");
    expect(large).toHaveLength(9);
    expect(large).toContainEqual({ x: 4, y: 1 });
    expect(large).toContainEqual({ x: 6, y: 3 });
  });

  it("is clipped to the hull at its edge and corners", () => {
    const deck = fieldDeck();
    expect(blastTiles(deck, { x: 0, y: 0 }, "large")).toHaveLength(4);
    expect(blastTiles(deck, { x: 7, y: 0 }, "large")).toHaveLength(6);
    expect(blastTiles(notchedDeck(), { x: 1, y: 1 }, "large")).toHaveLength(8);
  });
});

describe("the hull bar (slice 5 call 10)", () => {
  it("is max less each scar's damage not yet recovered, never below zero", () => {
    expect(scarDamageLeft(scar(8, 4))).toBe(4);
    expect(integrityFromScars({ max: 100, scars: [scar(8, 0), scar(3, 1.5)] })).toBe(90.5);
    expect(integrityFromScars({ max: 10, scars: [scar(8, 0), scar(8, 0)] })).toBe(0);
  });

  it("starts whole at the deck's hull class max", () => {
    expect(wholeHull(fieldDeck())).toEqual({ integrity: 100, max: 100, scars: [] });
  });
});
