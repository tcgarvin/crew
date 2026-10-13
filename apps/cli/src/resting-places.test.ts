/**
 * §the-body-aboard on the authored freighters: each deck's resting places for the dead lie in its
 * cargo hold, clear of the stowage and every other zone, and the first is clear of the ramps.
 */
import { loadBundle } from "@crew/content";
import { type DeckDefId, restingPlaces } from "@crew/sim";
import { describe, expect, it } from "vitest";

function bundle() {
  const result = loadBundle();
  if (!result.ok) throw new Error("content bundle failed validation");
  return result.bundle;
}

describe("resting places on the freighters (§the-body-aboard)", () => {
  for (const id of ["deck.freighter_mk1", "deck.freighter_mk2"] as DeckDefId[]) {
    it(`${id}: in the cargo hold, off every zone, the first clear of the ramps`, () => {
      const content = bundle();
      const deck = content.decks[id];
      if (deck === undefined) throw new Error(`no ${id}`);
      const hold = deck.compartments.find((c) => c.tags.includes("cargoHold"));
      if (hold === undefined) throw new Error(`${id} has no cargo hold`);
      const places = restingPlaces(content, deck);
      expect(places.length).toBeGreaterThan(4);
      for (const t of places) {
        expect(deck.tiles[t.y]?.charAt(t.x)).toBe(hold.symbol);
        expect(deck.zones.some((z) => z.tiles.some((z1) => z1.x === t.x && z1.y === t.y))).toBe(
          false,
        );
      }
      // The first is out of the way of the ramps: never beside a ramp's transfer tile.
      const first = places[0];
      if (first === undefined) throw new Error("no resting place");
      const ramps = [...deck.docking.cargoTransferTiles, ...deck.docking.personnelTransferTiles];
      for (const ramp of ramps) {
        expect(Math.max(Math.abs(first.x - ramp.x), Math.abs(first.y - ramp.y))).toBeGreaterThan(1);
      }
    });
  }
});
