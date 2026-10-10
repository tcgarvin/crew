/**
 * Dockside §2.6 (§dock-drawing): ramps drawn by how far open they are. The cargo ramp is a hinged
 * plate that lowers about two tiles out over the berth; the personnel ramp a narrow gangway.
 * Passability is the sim's business (only once fully open); this only shows the leaf travelling.
 * Tile units.
 */
import type { RenderFrame } from "@crew/sim";
import type { DeckLayout, RampLayoutDoor } from "./deckLayout";

const CARGO_REACH = 2;
const CARGO_WIDTH = 1.1;
const GANGWAY_REACH = 1.6;
const GANGWAY_WIDTH = 0.5;
const PLATE = "#59667a";
const PLATE_EDGE = "#a9bbcd";
const CHEVRON = "rgba(226, 192, 68, 0.75)";

/** Rotate a ramp-local point (`along` out of the hull, `across` it) into deck coordinates. */
function at(ramp: RampLayoutDoor, along: number, across: number): readonly [number, number] {
  const { x: ox, y: oy } = ramp.out;
  // `across` runs perpendicular to `out`: (-oy, ox).
  return [ramp.cx + ox * along - oy * across, ramp.cy + oy * along + ox * across];
}

function quad(
  ctx: CanvasRenderingContext2D,
  ramp: RampLayoutDoor,
  along0: number,
  along1: number,
  half: number,
): void {
  const corners = [
    at(ramp, along0, -half),
    at(ramp, along1, -half),
    at(ramp, along1, half),
    at(ramp, along0, half),
  ];
  ctx.beginPath();
  corners.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function drawCargoRamp(
  ctx: CanvasRenderingContext2D,
  ramp: RampLayoutDoor,
  open: number,
  px: number,
) {
  const reach = CARGO_REACH * open;
  const half = CARGO_WIDTH / 2;
  quad(ctx, ramp, 0, reach, half);
  ctx.fillStyle = PLATE;
  ctx.fill();
  ctx.strokeStyle = PLATE_EDGE;
  ctx.lineWidth = 1.5 * px;
  ctx.stroke();
  // Chevrons pointing out, so the plate reads as a ramp rather than a floor tile.
  ctx.strokeStyle = CHEVRON;
  ctx.lineWidth = Math.max(1.5 * px, 0.08);
  ctx.beginPath();
  for (let along = 0.45; along < reach - 0.1; along += 0.5) {
    const [lx, ly] = at(ramp, along - 0.2, -half * 0.6);
    const [tx, ty] = at(ramp, along, 0);
    const [rx, ry] = at(ramp, along - 0.2, half * 0.6);
    ctx.moveTo(lx, ly);
    ctx.lineTo(tx, ty);
    ctx.lineTo(rx, ry);
  }
  ctx.stroke();
}

function drawGangway(
  ctx: CanvasRenderingContext2D,
  ramp: RampLayoutDoor,
  open: number,
  px: number,
) {
  const reach = GANGWAY_REACH * open;
  const half = GANGWAY_WIDTH / 2;
  quad(ctx, ramp, 0, reach, half);
  ctx.fillStyle = PLATE;
  ctx.fill();
  // Handrails along both sides.
  ctx.strokeStyle = PLATE_EDGE;
  ctx.lineWidth = Math.max(1.5 * px, 0.06);
  ctx.beginPath();
  for (const side of [-half, half]) {
    const [x0, y0] = at(ramp, 0, side);
    const [x1, y1] = at(ramp, reach, side);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
  ctx.stroke();
}

/** Every ramp on this deck, extended by its `openFraction`. `px` is one CSS pixel in tiles. */
export function drawRamps(
  ctx: CanvasRenderingContext2D,
  layout: Pick<DeckLayout, "deckId" | "doors">,
  frame: Pick<RenderFrame, "doors">,
  px: number,
): void {
  const openByKey = new Map(
    frame.doors
      .filter((d) => d.deckId === layout.deckId)
      .map((d) => [d.placementKey, d.openFraction] as const),
  );
  for (const door of layout.doors) {
    if (door.kind !== "ramp") continue;
    const open = openByKey.get(door.placementKey) ?? 0;
    if (open <= 0) continue;
    if (door.role === "cargo") drawCargoRamp(ctx, door, open, px);
    else drawGangway(ctx, door, open, px);
  }
}
