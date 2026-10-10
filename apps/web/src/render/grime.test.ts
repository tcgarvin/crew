/** §dirt-grid: the grime tint's alpha and the squares it draws, from a synthetic dirt frame. */
import type { DeckDefId, DirtFrame, Tick } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { buildDeckLayout } from "./deckLayout";
import { GRIME_MIN_CELL, type GrimeTint, drawGrime, grimeAlpha } from "./grime";
import { mockCanvas } from "./testCanvas";

const { bundle, config, scenarioId } = loadWebContent();
const scenario = bundle.scenarios[scenarioId];
const deck = scenario === undefined ? undefined : bundle.decks[scenario.deckId];
if (deck === undefined) throw new Error("no deck");
const layout = buildDeckLayout(deck, bundle);
const tint: GrimeTint = { tintScale: 1.2, tintMaxAlpha: 0.35 };

function dirtFrame(cells: Uint8Array, overrides: Partial<DirtFrame> = {}): DirtFrame {
  return {
    tick: 0 as Tick,
    deckId: layout.deckId,
    width: layout.width,
    height: layout.height,
    cells,
    tiers: {},
    ...overrides,
  };
}

describe("grimeAlpha", () => {
  it("skips cells under the speck threshold", () => {
    expect(grimeAlpha(0, tint)).toBe(0);
    expect(grimeAlpha(GRIME_MIN_CELL - 1, tint)).toBe(0);
    expect(grimeAlpha(GRIME_MIN_CELL, tint)).toBeGreaterThan(0);
  });

  it("scales with the cell and caps at tintMaxAlpha", () => {
    expect(grimeAlpha(51, tint)).toBeCloseTo((51 / 255) * 1.2);
    expect(grimeAlpha(102, tint)).toBeGreaterThan(grimeAlpha(51, tint));
    // 0.35 / 1.2 × 255 ≈ 74: everything dirtier is the same wash.
    expect(grimeAlpha(80, tint)).toBe(0.35);
    expect(grimeAlpha(255, tint)).toBe(0.35);
  });

  it("reads the authored knobs", () => {
    const authored = config.values.dirt;
    expect(grimeAlpha(255, authored)).toBe(authored.tintMaxAlpha);
  });
});

describe("drawGrime", () => {
  const floor = layout.tiles.filter((t) => t.compartmentKey !== undefined);
  const voidTile = layout.tiles.find((t) => t.compartmentKey === undefined);

  it("draws nothing on a clean deck", () => {
    const canvas = mockCanvas();
    drawGrime(canvas.ctx, layout, { dirt: dirtFrame(new Uint8Array(layout.tiles.length)), tint });
    expect(canvas.calls.get("fillRect") ?? 0).toBe(0);
  });

  it("draws one square per dirty floor tile, none on void", () => {
    const cells = new Uint8Array(layout.tiles.length);
    const lane = floor.slice(0, 5);
    for (const tile of lane) cells[tile.y * layout.width + tile.x] = 120;
    // A speck beside the lane is not drawn.
    const speck = floor[5];
    if (speck !== undefined) cells[speck.y * layout.width + speck.x] = GRIME_MIN_CELL - 1;
    if (voidTile !== undefined) cells[voidTile.y * layout.width + voidTile.x] = 255;
    const canvas = mockCanvas();
    drawGrime(canvas.ctx, layout, { dirt: dirtFrame(cells), tint });
    expect(canvas.calls.get("fillRect")).toBe(lane.length);
  });

  it("throws on a frame for another deck or of another size", () => {
    const cells = new Uint8Array(layout.tiles.length);
    const canvas = mockCanvas();
    const other = dirtFrame(cells, { deckId: "deck.other" as DeckDefId });
    expect(() => drawGrime(canvas.ctx, layout, { dirt: other, tint })).toThrow(/does not match/);
    const short = dirtFrame(new Uint8Array(3));
    expect(() => drawGrime(canvas.ctx, layout, { dirt: short, tint })).toThrow(/cells/);
  });
});
