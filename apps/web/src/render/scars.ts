/**
 * Slice 5 (§hull-scars-and-ship-loss, calls 16 and 25): hull scars on the deck, one per impact,
 * drawn per tile on the grime layer's pattern (over the floor, under the people) from
 * `RenderFrame.hull.scars` at the tick playback has reached. An unpatched scar is a charred hole
 * with glowing cracks; a patched one is a dull plate over it, dimmer, so the eye goes to the work
 * still to do.
 */
import type { RenderScar } from "@crew/sim";
import { hash } from "./stars";

const HOLE_FILL = "rgba(14, 10, 8, 0.82)";
const CRACK_COLOR = "rgba(232, 104, 48, 0.9)";
const PATCH_FILL = "rgba(128, 140, 152, 0.38)";
const PATCH_EDGE = "rgba(170, 182, 194, 0.45)";
const SELECTED_EDGE = "#ffffff";

/** Fraction of the tile the scar covers, by rock: a large rock's centre is the worse hole. */
const HOLE_SIZE = { small: 0.5, large: 0.74 } as const;

/** 0..1 from a scar's id and a channel, so each scar's cracks lie the same way on every frame. */
function unit(id: string, channel: number): number {
  let n = channel * 977;
  for (let i = 0; i < id.length; i++) n = Math.imul(n ^ id.charCodeAt(i), 0x01000193);
  return hash(n) / 4_294_967_296;
}

/**
 * Draw every scar. The context must be in deck tile units (`inTileSpace`); `px` is one CSS pixel
 * in tiles, for line widths that stay crisp at every zoom.
 */
export function drawScars(
  ctx: CanvasRenderingContext2D,
  scars: readonly RenderScar[],
  px: number,
  selectedId?: string,
): void {
  for (const scar of scars) {
    const size = HOLE_SIZE[scar.rock];
    const inset = (1 - size) / 2;
    const cx = scar.x + 0.5;
    const cy = scar.y + 0.5;
    if (scar.patched) {
      ctx.fillStyle = PATCH_FILL;
      ctx.fillRect(scar.x + inset, scar.y + inset, size, size);
      ctx.strokeStyle = PATCH_EDGE;
      ctx.lineWidth = px;
      ctx.strokeRect(scar.x + inset, scar.y + inset, size, size);
    } else {
      ctx.fillStyle = HOLE_FILL;
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      drawCracks(ctx, scar, cx, cy, size, px);
    }
    if (scar.id === selectedId) {
      ctx.strokeStyle = SELECTED_EDGE;
      ctx.lineWidth = 2 * px;
      ctx.strokeRect(scar.x + 0.04, scar.y + 0.04, 0.92, 0.92);
    }
  }
}

function drawCracks(
  ctx: CanvasRenderingContext2D,
  scar: RenderScar,
  cx: number,
  cy: number,
  size: number,
  px: number,
): void {
  const cracks = scar.rock === "large" ? 5 : 3;
  ctx.strokeStyle = CRACK_COLOR;
  ctx.lineWidth = 1.5 * px;
  ctx.beginPath();
  for (let i = 0; i < cracks; i++) {
    const angle = ((i + unit(scar.id, i)) / cracks) * Math.PI * 2;
    const reach = (size / 2) * (0.9 + 0.5 * unit(scar.id, 10 + i));
    // A crack runs out from inside the hole and bends once on its way.
    const bend = (unit(scar.id, 20 + i) - 0.5) * 0.8;
    ctx.moveTo(cx + Math.cos(angle) * size * 0.15, cy + Math.sin(angle) * size * 0.15);
    ctx.lineTo(
      cx + Math.cos(angle + bend) * reach * 0.6,
      cy + Math.sin(angle + bend) * reach * 0.6,
    );
    ctx.lineTo(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
  }
  ctx.stroke();
}

/** The scar on tile (x, y) of the deck frame, if any (the newest when one tile holds several). */
export function scarAt(scars: readonly RenderScar[], x: number, y: number): RenderScar | undefined {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  let found: RenderScar | undefined;
  for (const scar of scars) if (scar.x === tx && scar.y === ty) found = scar;
  return found;
}
