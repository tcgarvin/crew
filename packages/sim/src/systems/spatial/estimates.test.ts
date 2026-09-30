import { describe, expect, it } from "vitest";
import { estimateTravelTicks, knownRoute } from "./estimates";
import { DECK12, deck12World } from "./fixtures/deck-12x8";
import { deckGeometry } from "./geometry";

describe("estimates", () => {
  it("routes over the schematic and adds door opening time", () => {
    const { world } = deck12World();
    const geometry = deckGeometry(world.caches, DECK12.deck);
    const config = world.config.values;
    expect(knownRoute(geometry, { x: 0, y: 5 }, { x: 11, y: 5 }, config)).toHaveLength(12);
    // 11 tiles at 2 tiles/s = 5.5 s = 110 ticks.
    expect(estimateTravelTicks(geometry, { x: 0, y: 5 }, { x: 11, y: 5 }, config)).toBe(110);
    // Into room B through powered door B: 3 tiles (1.5 s) + openSeconds (1 s) = 50 ticks.
    expect(estimateTravelTicks(geometry, { x: 5, y: 6 }, { x: 5, y: 3 }, config)).toBe(50);
    expect(estimateTravelTicks(geometry, { x: 0, y: 5 }, { x: 0, y: 7 }, config)).toBeNull();
  });
});
