/**
 * Dockside §2.5 (D58): the ship's silhouette and engine plume, built from the deck's bounds alone,
 * so the deck reads as a ship. D72: the bow is always the high-x end (`orientation.ts`), so a
 * tapered nose sits fore of the deck and the engine bells aft of it whatever the compartments are
 * called. Geometry is in deck tile units; callers draw it under a tile-space transform.
 */
import type { RenderFrame, RenderMachineState } from "@crew/sim";
import type { DeckLayout } from "./deckLayout";
import { aftOf, endsAlongShip, foreOf } from "./orientation";

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
  /** The bridge windows: a polyline just aft of the nose's leading edges. */
  readonly windows: readonly Point[];
  /** Everything the hull covers, nose to bell mouths (not the plume). */
  readonly bounds: Bounds;
}

/** Hull plating beyond the deck's outer walls, tiles. */
export const HULL_RIM = 0.35;
const BELL_LENGTH = 1.8;
/** Plume length at full output, tiles beyond the bell mouth. */
const PLUME_MAX_TILES = 11;
/** Where the nose's shoulders meet the body, as a fraction of the deck's height from each side. */
const NOSE_SHOULDER = 0.15;
/** How far the bridge windows sit aft of the nose's leading edges, tiles. */
const WINDOW_INSET = 0.45;

type HullLayout = Pick<DeckLayout, "width" | "height">;

export function hullGeometry(layout: HullLayout): HullGeometry {
  const w = layout.width;
  const h = layout.height;
  const top = -HULL_RIM;
  const bottom = h + HULL_RIM;
  const { bow, stern } = endsAlongShip(-HULL_RIM, w + HULL_RIM);
  const nose = Math.min(5, Math.max(2, h * 0.2));
  const tip = bow + foreOf(nose);
  const cheek = bow + foreOf(nose * 0.85);
  const shoulder = bow + foreOf(nose * 0.45);
  // The nose tapers to a blunt tip at mid-height.
  const outline: Point[] = [
    { x: stern, y: top },
    { x: bow, y: top },
    { x: shoulder, y: h * NOSE_SHOULDER },
    { x: cheek, y: h * 0.34 },
    { x: tip, y: h * 0.44 },
    { x: tip, y: h * 0.56 },
    { x: cheek, y: h * 0.66 },
    { x: shoulder, y: h * (1 - NOSE_SHOULDER) },
    { x: bow, y: bottom },
    { x: stern, y: bottom },
  ];
  const windows: Point[] = [
    { x: cheek + aftOf(WINDOW_INSET), y: h * 0.34 + WINDOW_INSET * 0.6 },
    { x: tip + aftOf(WINDOW_INSET), y: h * 0.44 + WINDOW_INSET * 0.3 },
    { x: tip + aftOf(WINDOW_INSET), y: h * 0.56 - WINDOW_INSET * 0.3 },
    { x: cheek + aftOf(WINDOW_INSET), y: h * 0.66 - WINDOW_INSET * 0.6 },
  ];
  const bells: Bell[] = [0.3, 0.7].map((at) => ({
    y: h * at,
    throatX: stern,
    mouthX: stern + aftOf(BELL_LENGTH),
    throatHalf: h * 0.08,
    mouthHalf: h * 0.13,
  }));
  const mouth = stern + aftOf(BELL_LENGTH);
  return {
    outline,
    bells,
    windows,
    bounds: { minX: Math.min(tip, mouth), minY: top, maxX: Math.max(tip, mouth), maxY: bottom },
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
    const end = bell.mouthX + aftOf(length);
    const control = bell.mouthX + aftOf(length * 0.35);
    const gradient = ctx.createLinearGradient(bell.mouthX, 0, end, 0);
    gradient.addColorStop(0, `rgba(235, 245, 255, ${0.9 * Math.min(1, strength * 1.6)})`);
    gradient.addColorStop(0.25, `rgba(120, 190, 255, ${0.7 * strength})`);
    gradient.addColorStop(1, "rgba(60, 110, 255, 0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(bell.mouthX, bell.y - half);
    ctx.quadraticCurveTo(control, bell.y - half * 0.9, end, bell.y);
    ctx.quadraticCurveTo(control, bell.y + half * 0.9, bell.mouthX, bell.y + half);
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
  ctx.strokeStyle = WINDOW;
  ctx.lineWidth = Math.max(2 * px, 0.18);
  ctx.lineCap = "round";
  ctx.beginPath();
  hull.windows.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
}
