/**
 * Dockside §2.5 (D58): the ship's silhouette and engine plume, built from the deck's bounds, so the
 * deck reads as a ship. A tapered nose fore (west) beyond the bridge, engine bells aft (east)
 * beyond engineering. No content change: an optional `hull` block on `DeckDef` can come with a
 * second ship. Geometry is in deck tile units; callers draw it under a tile-space transform.
 */
import type { RenderFrame, RenderMachineState } from "@crew/sim";
import type { DeckLayout } from "./deckLayout";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** An engine bell: a trapezoid from its throat at the hull to its mouth aft. */
export interface Bell {
  readonly y: number;
  readonly throatX: number;
  readonly mouthX: number;
  readonly throatHalf: number;
  readonly mouthHalf: number;
}

export interface HullGeometry {
  /** Body plus nose, clockwise from the top-left corner of the body. */
  readonly outline: readonly Point[];
  readonly bells: readonly Bell[];
  /** Everything the hull covers, nose to bell mouths (not the plume). */
  readonly bounds: Bounds;
}

/** Hull plating beyond the deck's outer walls, tiles. */
export const HULL_RIM = 0.35;
const BELL_LENGTH = 1.8;
/** Plume length at full output, tiles beyond the bell mouth. */
const PLUME_MAX_TILES = 11;

type HullLayout = Pick<DeckLayout, "width" | "height" | "compartmentBoxes" | "compartmentTags">;

/** The tile box of the first compartment tagged `tag`, or the whole deck if none is. */
function boxOf(layout: HullLayout, tag: string): Bounds {
  for (const [key, tags] of Object.entries(layout.compartmentTags)) {
    const box = layout.compartmentBoxes[key];
    if (box !== undefined && tags.includes(tag)) return box;
  }
  return { minX: 0, minY: 0, maxX: layout.width, maxY: layout.height };
}

export function hullGeometry(layout: HullLayout): HullGeometry {
  const w = layout.width;
  const h = layout.height;
  const left = -HULL_RIM;
  const right = w + HULL_RIM;
  const top = -HULL_RIM;
  const bottom = h + HULL_RIM;
  const nose = Math.min(5, Math.max(2, h * 0.2));
  const tip = left - nose;
  // The nose tapers to a blunt tip at mid-height, its shoulders level with the bridge.
  const bridge = boxOf(layout, "bridge");
  const shoulder = Math.max(0.08, Math.min(0.3, bridge.minY / h + 0.1));
  const outline: Point[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
    { x: left - nose * 0.45, y: h * (1 - shoulder) },
    { x: left - nose * 0.85, y: h * 0.66 },
    { x: tip, y: h * 0.56 },
    { x: tip, y: h * 0.44 },
    { x: left - nose * 0.85, y: h * 0.34 },
    { x: left - nose * 0.45, y: h * shoulder },
  ];
  const engineering = boxOf(layout, "engineering");
  const span = engineering.maxY - engineering.minY;
  const bells: Bell[] = [0.3, 0.7].map((at) => ({
    y: engineering.minY + span * at,
    throatX: right,
    mouthX: right + BELL_LENGTH,
    throatHalf: span * 0.08,
    mouthHalf: span * 0.13,
  }));
  return {
    outline,
    bells,
    bounds: { minX: tip, minY: top, maxX: right + BELL_LENGTH, maxY: bottom },
  };
}

const ENGINE_OUTPUT: Readonly<Record<RenderMachineState, number>> = {
  ok: 1,
  degraded: 0.55,
  off: 0,
  failed: 0,
};

/**
 * Mean output of the engines as the frame shows them, 0..1: a derated engine gives a weaker
 * plume. A deck with no engines is not constrained (as travel's propulsion factor).
 */
export function engineOutput(
  frame: Pick<RenderFrame, "machines">,
  layout: Pick<DeckLayout, "deckId" | "machines">,
): number {
  const engineKeys = new Set(
    layout.machines.filter((m) => m.tags.includes("engine")).map((m) => m.placementKey),
  );
  if (engineKeys.size === 0) return 1;
  let sum = 0;
  let count = 0;
  for (const machine of frame.machines) {
    if (machine.deckId !== layout.deckId || !engineKeys.has(machine.placementKey)) continue;
    sum += ENGINE_OUTPUT[machine.state];
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

const HULL_FILL = "#1d2530";
const HULL_EDGE = "#55687c";
const BELL_FILL = "#2b333d";
const WINDOW = "rgba(140, 200, 255, 0.55)";

function tracePolygon(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

function traceBell(ctx: CanvasRenderingContext2D, bell: Bell): void {
  tracePolygon(ctx, [
    { x: bell.throatX, y: bell.y - bell.throatHalf },
    { x: bell.mouthX, y: bell.y - bell.mouthHalf },
    { x: bell.mouthX, y: bell.y + bell.mouthHalf },
    { x: bell.throatX, y: bell.y + bell.throatHalf },
  ]);
}

/**
 * The plume behind each bell: `strength` is the scene's plume times the engines' output. `flicker`
 * in [-1, 1] wobbles its length (0 under reduced motion).
 */
export function drawPlume(
  ctx: CanvasRenderingContext2D,
  hull: HullGeometry,
  strength: number,
  flicker: number,
): void {
  if (strength <= 0.01) return;
  for (const [i, bell] of hull.bells.entries()) {
    const wobble = 1 + 0.06 * flicker * (i % 2 === 0 ? 1 : -0.8);
    const length = PLUME_MAX_TILES * strength * wobble;
    const half = bell.mouthHalf * (0.55 + 0.35 * strength);
    const gradient = ctx.createLinearGradient(bell.mouthX, 0, bell.mouthX + length, 0);
    gradient.addColorStop(0, `rgba(235, 245, 255, ${0.9 * Math.min(1, strength * 1.6)})`);
    gradient.addColorStop(0.25, `rgba(120, 190, 255, ${0.7 * strength})`);
    gradient.addColorStop(1, "rgba(60, 110, 255, 0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(bell.mouthX, bell.y - half);
    ctx.quadraticCurveTo(
      bell.mouthX + length * 0.35,
      bell.y - half * 0.9,
      bell.mouthX + length,
      bell.y,
    );
    ctx.quadraticCurveTo(
      bell.mouthX + length * 0.35,
      bell.y + half * 0.9,
      bell.mouthX,
      bell.y + half,
    );
    ctx.closePath();
    ctx.fill();
  }
}

/** Silhouette, bells and a few nose windows. `px` is one CSS pixel in tile units. */
export function drawHull(ctx: CanvasRenderingContext2D, hull: HullGeometry, px: number): void {
  ctx.strokeStyle = HULL_EDGE;
  ctx.lineWidth = 1.5 * px;
  ctx.lineJoin = "round";
  for (const bell of hull.bells) {
    traceBell(ctx, bell);
    ctx.fillStyle = BELL_FILL;
    ctx.fill();
    ctx.stroke();
  }
  tracePolygon(ctx, hull.outline);
  ctx.fillStyle = HULL_FILL;
  ctx.fill();
  ctx.stroke();
  // Bridge windows along the nose's leading edges.
  const [, , , , lowShoulder, lowCheek, lowTip, highTip, highCheek, highShoulder] = hull.outline;
  if (
    lowShoulder !== undefined &&
    lowCheek !== undefined &&
    lowTip !== undefined &&
    highTip !== undefined &&
    highCheek !== undefined &&
    highShoulder !== undefined
  ) {
    const inset = 0.45;
    ctx.strokeStyle = WINDOW;
    ctx.lineWidth = Math.max(2 * px, 0.18);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(highCheek.x + inset, highCheek.y + inset * 0.6);
    ctx.lineTo(highTip.x + inset, highTip.y + inset * 0.3);
    ctx.lineTo(lowTip.x + inset, lowTip.y - inset * 0.3);
    ctx.lineTo(lowCheek.x + inset, lowCheek.y - inset * 0.6);
    ctx.stroke();
    ctx.lineCap = "butt";
  }
  ctx.lineJoin = "miter";
}
