/**
 * The grime tint (§dirt-grid, ship-life slice 3 call 14): a translucent square of one colour over
 * each floor tile's room fill, darker the dirtier the cell, so a path walked often shows as a
 * darker lane and a neglected room as a wash. Drawn from the latest `DirtFrame` playback has
 * reached (`host/dirtQueue.ts`), never from the run-ahead state.
 */
import type { ConfigDef, DirtFrame } from "@crew/sim";
import type { DeckLayout } from "./deckLayout";

/** The tint's one colour, as RGB (`#5a4a30`). */
const GRIME_RGB = "90, 74, 48";

/** Cells below this (of 255) are not drawn: a speck nobody would notice. */
export const GRIME_MIN_CELL = 8;

/** The renderer's two dirt knobs (`config.dirt.tintScale`, `tintMaxAlpha`). */
export type GrimeTint = Pick<ConfigDef["dirt"], "tintScale" | "tintMaxAlpha">;

/** What `drawFrame` needs to tint the deck: the frame in view and the tint knobs. */
export interface GrimePaint {
  readonly dirt: DirtFrame;
  readonly tint: GrimeTint;
}

/**
 * The tint's alpha for a cell (0..255): `min(tintMaxAlpha, cell / 255 × tintScale)`, and 0 under
 * `GRIME_MIN_CELL`.
 */
export function grimeAlpha(cell: number, tint: GrimeTint): number {
  if (cell < GRIME_MIN_CELL) return 0;
  return Math.min(tint.tintMaxAlpha, (cell / 255) * tint.tintScale);
}

/**
 * Tint the deck's floor tiles. The context must already be in deck tile units (`inTileSpace`).
 * A frame for another deck, or of another size, is a protocol mismatch, not something to draw
 * half of: it throws.
 */
export function drawGrime(
  ctx: CanvasRenderingContext2D,
  layout: Pick<DeckLayout, "deckId" | "width" | "height" | "tiles">,
  paint: GrimePaint,
): void {
  const { dirt, tint } = paint;
  if (dirt.deckId !== layout.deckId || dirt.width !== layout.width) {
    throw new Error(
      `drawGrime: dirt frame for ${dirt.deckId} (${dirt.width}×${dirt.height}) does not match deck ${layout.deckId} (${layout.width}×${layout.height})`,
    );
  }
  if (dirt.height !== layout.height || dirt.cells.length !== layout.tiles.length) {
    throw new Error(
      `drawGrime: dirt frame has ${dirt.cells.length} cells for a ${layout.width}×${layout.height} deck`,
    );
  }
  for (const tile of layout.tiles) {
    if (tile.compartmentKey === undefined) continue;
    const alpha = grimeAlpha(dirt.cells[tile.y * layout.width + tile.x] ?? 0, tint);
    if (alpha <= 0) continue;
    ctx.fillStyle = `rgba(${GRIME_RGB}, ${alpha.toFixed(3)})`;
    ctx.fillRect(tile.x, tile.y, 1, 1);
  }
}
