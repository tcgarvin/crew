/**
 * Crate drawing primitives in screen space: an item's colour, a crate square, a count tag and a
 * loaded hand truck. Shared by the ship's freight (`draw.ts`) and the dock's trolleys and staged
 * props (`locals.ts`).
 */
import type { CargoClass, RenderItem, RenderItemKind } from "@crew/sim";
import { TEXT_COLOR } from "./screen";
import { segment } from "./shapes";

/**
 * Polish A (§rooms-items-and-cargo): crate colour per freight class; other kinds get one colour
 * each.
 */
export const CARGO_COLORS: Readonly<Record<CargoClass, string>> = {
  general: "#d8ab6c",
  fragile: "#8cc4f2",
  perishable: "#bd9cf2",
  hazardous: "#f27f3d",
};

const ITEM_COLORS: Readonly<Record<RenderItemKind, string>> = {
  crate: CARGO_COLORS.general,
  tool: "#cfd8e3",
  food: "#e8cf6a",
  other: "#9aa7b5",
};

export function itemColor(item: Pick<RenderItem, "kind" | "cargoClass">): string {
  if (item.kind === "crate" && item.cargoClass !== undefined) return CARGO_COLORS[item.cargoClass];
  return ITEM_COLORS[item.kind];
}

const BADGE_HEIGHT = 11;

/** A small count tag hung off a crate's top-right corner, so it never hides the crate. */
export function drawBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  count: number,
): void {
  const text = `×${count}`;
  ctx.font = "700 9px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 4;
  const h = BADGE_HEIGHT;
  ctx.fillStyle = "rgba(5, 7, 10, 0.85)";
  ctx.fillRect(x, y - h, w, h);
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 2, y - h / 2 + 0.5);
}

/**
 * How strongly an offered crate (§offered-freight) is filled: enough to show its class, clearly not
 * solid.
 */
const OFFERED_FILL_ALPHA = 0.3;

export function drawCrate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
  selected: boolean,
  offered = false,
): void {
  const x = cx - size / 2;
  const y = cy - size / 2;
  ctx.save();
  if (offered) ctx.globalAlpha *= OFFERED_FILL_ALPHA;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.restore();
  if (offered) {
    // Freight on offer is nobody's yet: a dashed outline in its class colour reads as
    // "available" rather than as cargo the crew are handling, or as the dock's own crates.
    ctx.save();
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, y + 0.75, size - 1.5, size - 1.5);
    ctx.restore();
  } else {
    ctx.strokeStyle = "rgba(10, 14, 20, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, size, size);
    if (size >= 9) {
      // A strap across the lid, so it reads as a crate rather than a machine tile.
      segment(ctx, x, cy, x + size, cy);
    }
  }
  if (selected) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 3, y - 3, size + 6, size + 6);
  }
}

/** How far a loaded truck drawn at `size` (`drawLoadedTruck`) rises above its pusher's dot, px. */
export function loadedTruckRise(size: number): number {
  // Handle top: base (footY + 0.45 size) less two crates (0.6 size each) and 4px.
  return size * 0.75 + 4;
}

/**
 * §hand-truck-drawing: a hand truck (or a dock hand's trolley, §locals-and-props) beside the person
 * pushing it: an upright handle and a toe plate with the crates stacked on it, one colour each (two
 * to a row, at most two rows; a count tag says how many when there are more than one).
 */
export function drawLoadedTruck(
  ctx: CanvasRenderingContext2D,
  x: number,
  footY: number,
  size: number,
  crateColors: readonly string[],
): void {
  const crate = size * 0.6;
  const left = x - crate;
  const base = footY + size * 0.45;
  ctx.strokeStyle = "rgba(231, 237, 243, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(left - 2, base - crate * 2 - 4);
  ctx.lineTo(left - 2, base);
  ctx.lineTo(left + crate * 2 + 1, base);
  ctx.stroke();
  crateColors.slice(0, 4).forEach((color, i) => {
    const cx = left + crate / 2 + (i % 2) * crate;
    const cy = base - crate / 2 - 1 - Math.floor(i / 2) * crate;
    drawCrate(ctx, cx, cy, crate, color, false);
  });
  if (crateColors.length > 1) {
    // Hung below the toe plate, not above the stack: above, it landed on the pusher's label
    // ("Priya Kessler — ×3 hauling") on every trip.
    drawBadge(ctx, left + crate * 2 + 2, base + BADGE_HEIGHT + 1, crateColors.length);
  }
}
