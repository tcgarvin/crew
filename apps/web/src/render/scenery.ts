/**
 * Dockside §2.3–2.4 (D58): port scenery without dock maps. Everything here draws in deck tile
 * units (the caller sets a tile-space transform inside the portrait rotation) from a `Scene`, so
 * it is a pure picture of the stage and progress. Phase 2's dock maps replace the stand-in berth
 * and palettes; the layering stays.
 *
 * - Far: the station's outer structure, or the planet's disc, growing ahead and receding astern.
 * - Berth (behind the hull): the station bay's floor, or the planet's fields and landing pad.
 * - Foreground (over the deck): bay walls and gantries, or clouds and dust, translucent where they
 *   cross the deck so the crew stay legible.
 */
import type { Bounds } from "./hull";
import { type Scene, smooth } from "./scene";
import { wrap } from "./stars";

export interface SceneryFrame {
  /** Deck size in tiles. */
  readonly width: number;
  readonly height: number;
  /** The visible area, tile units. */
  readonly view: Bounds;
  /** One CSS pixel in tile units. */
  readonly px: number;
}

/** How much the far scenery moves per unit of berth offset astern: it is far away. */
const FAR_PARALLAX = 0.08;
/** Where an arriving port first shows, as a fraction of the deck length (negative: off the nose). */
const FAR_START = -0.12;
/** The station bay beyond each end of the ship, in deck lengths. */
const BAY_FORE = 0.35;
const BAY_AFT = 0.35;
/** Gap between the hull and the bay walls, tiles; the walls run on off screen. */
const WALL_GAP = 1.1;
const WALL_DEPTH = 8;
/** Max opacity of foreground pieces where they cross the deck. */
const GANTRY_ALPHA = 0.2;
const CLOUD_ALPHA = 0.35;
const DUST_ALPHA = 0.45;

/** The planet's ground scale for an altitude: full size landed, a third at the top of the sky. */
export function groundScale(altitude: number): number {
  return 1 / (1 + 2 * altitude);
}

function rect(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

/** Space, or the planet's sky gradient over it. Fills `view`. */
export function drawSky(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  const { view } = f;
  ctx.fillStyle = scene.palette.space;
  rect(ctx, view.minX, view.minY, view.maxX, view.maxY);
  if (scene.sky <= 0) return;
  // Lighter ahead, toward where the ship is going.
  const gradient = ctx.createLinearGradient(view.minX, 0, view.maxX, 0);
  gradient.addColorStop(0, scene.palette.sky);
  gradient.addColorStop(1, scene.palette.skyLow);
  ctx.globalAlpha = scene.sky;
  ctx.fillStyle = gradient;
  rect(ctx, view.minX, view.minY, view.maxX, view.maxY);
  ctx.globalAlpha = 1;
}

function drawStation(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  cx: number,
  cy: number,
  r: number,
) {
  const { palette } = scene;
  ctx.strokeStyle = palette.structure;
  ctx.fillStyle = palette.structure;
  ctx.lineWidth = r * 0.05;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.stroke();
  ctx.lineWidth = r * 0.16;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette.structureLight;
  const light = Math.max(0.12, r * 0.025);
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    ctx.fillRect(cx + Math.cos(a) * r - light / 2, cy + Math.sin(a) * r - light / 2, light, light);
  }
}

function drawPlanet(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  cx: number,
  cy: number,
  r: number,
) {
  const { palette } = scene;
  ctx.globalAlpha = 1 - scene.sky * 0.9;
  const gradient = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  gradient.addColorStop(0, palette.structureLight);
  gradient.addColorStop(0.55, palette.structure);
  gradient.addColorStop(1, "#14251a");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${palette.cloudRgb}, 0.35)`;
  ctx.lineWidth = Math.max(0.15, r * 0.03);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Where the far scenery sits along the ship. Arriving, it grows from a point just off the nose
 * toward the middle of the view; departing, it falls astern with the berth (at a parallax).
 */
export function farCentreX(scene: Pick<Scene, "portOffset" | "portScale">, width: number): number {
  if (scene.portOffset >= 0) return width / 2 + scene.portOffset * width * FAR_PARALLAX;
  return width * (FAR_START + (0.5 - FAR_START) * scene.portScale);
}

/** The station structure or planet disc: a point ahead that grows, or a shrinking one astern. */
export function drawFarScenery(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  if (scene.portScale <= 0.001) return;
  const cx = farCentreX(scene, f.width);
  const cy = f.height / 2;
  const grown = scene.portScale;
  if (scene.setting === "station") {
    drawStation(ctx, scene, cx, cy, Math.max(0.2, grown * f.width * 0.8));
  } else {
    drawPlanet(ctx, scene, cx, cy, Math.max(0.3, grown * f.width * 1.4));
  }
}

/** Bay extent along the ship, tile units, at the scene's berth offset. */
function bayExtent(scene: Scene, f: SceneryFrame): { x0: number; x1: number } {
  const offset = scene.portOffset * f.width;
  return { x0: offset - BAY_FORE * f.width, x1: offset + f.width * (1 + BAY_AFT) };
}

function drawBayFloor(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  const { palette } = scene;
  const { x0, x1 } = bayExtent(scene, f);
  const offset = scene.portOffset * f.width;
  ctx.fillStyle = palette.ground;
  rect(ctx, x0, -WALL_GAP, x1, f.height + WALL_GAP);
  ctx.strokeStyle = palette.groundAccent;
  ctx.lineWidth = 2 * f.px;
  ctx.beginPath();
  for (let x = x0 + 4; x < x1; x += 4) {
    ctx.moveTo(x, -WALL_GAP);
    ctx.lineTo(x, f.height + WALL_GAP);
  }
  ctx.stroke();
  // The berth: hazard markings framing where the ship sits, the quay edge on the ramp side.
  ctx.strokeStyle = palette.marking;
  ctx.globalAlpha *= 0.7;
  ctx.lineWidth = Math.max(2 * f.px, 0.12);
  ctx.setLineDash([0.6, 0.4]);
  ctx.strokeRect(offset - 4.5, -0.75, f.width + 6.6, f.height + 1.5);
  ctx.setLineDash([]);
}

function drawGround(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  const { palette } = scene;
  const visible = 1 - smooth((scene.altitude - 0.35) / 0.6);
  if (visible <= 0) return;
  ctx.globalAlpha *= visible;
  const offset = scene.portOffset * f.width;
  // Fields: crop strips along the travel axis. They scale with height (far below looks small)
  // and slide with the berth at that scale.
  const scale = groundScale(scene.altitude);
  ctx.save();
  ctx.translate(f.width / 2 + offset * scale, f.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-f.width / 2, -f.height / 2);
  const x0 = -2 * f.width;
  const x1 = 3 * f.width;
  const y0 = -3 * f.height;
  const y1 = 4 * f.height;
  ctx.fillStyle = palette.ground;
  rect(ctx, x0, y0, x1, y1);
  ctx.fillStyle = palette.groundAccent;
  for (let y = y0, i = 0; y < y1; y += 3.2, i++) {
    if (i % 3 === 0) continue;
    const jog = (i * 7.3) % 11;
    rect(ctx, x0 + jog, y, x1, y + 1.6);
  }
  ctx.restore();
  // The pad slides in under the ship at full size, so it visibly arrives and stops.
  ctx.fillStyle = palette.pad;
  rect(ctx, offset - 2.2, -1.6, offset + f.width + 2.6, f.height + 1.6);
  ctx.strokeStyle = palette.marking;
  ctx.lineWidth = 0.18;
  ctx.strokeRect(offset - 1.6, -1.0, f.width + 3.6, f.height + 2.0);
}

/** Behind the hull: the bay floor, or the fields and pad. Faded by `portAlpha`. */
export function drawBerth(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  if (scene.portAlpha <= 0) return;
  ctx.globalAlpha = scene.portAlpha;
  if (scene.setting === "station") drawBayFloor(ctx, scene, f);
  else drawGround(ctx, scene, f);
  ctx.globalAlpha = 1;
}

function drawBayWalls(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  const { palette } = scene;
  const { x0, x1 } = bayExtent(scene, f);
  ctx.globalAlpha = scene.portAlpha;
  ctx.fillStyle = palette.wall;
  rect(ctx, x0, -WALL_GAP - WALL_DEPTH, x1, -WALL_GAP);
  rect(ctx, x0, f.height + WALL_GAP, x1, f.height + WALL_GAP + WALL_DEPTH);
  // Ribs and lights, so the wall visibly slides.
  ctx.strokeStyle = "#141a22";
  ctx.lineWidth = 0.25;
  ctx.beginPath();
  for (let x = x0 + 1.5; x < x1; x += 3) {
    ctx.moveTo(x, -WALL_GAP - WALL_DEPTH);
    ctx.lineTo(x, -WALL_GAP);
    ctx.moveTo(x, f.height + WALL_GAP);
    ctx.lineTo(x, f.height + WALL_GAP + WALL_DEPTH);
  }
  ctx.stroke();
  ctx.fillStyle = palette.structureLight;
  for (let x = x0 + 3; x < x1; x += 6) {
    rect(ctx, x - 0.15, -WALL_GAP - 0.45, x + 0.15, -WALL_GAP - 0.2);
    rect(ctx, x - 0.15, f.height + WALL_GAP + 0.2, x + 0.15, f.height + WALL_GAP + 0.45);
  }
  ctx.strokeStyle = palette.marking;
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  ctx.moveTo(x0, -WALL_GAP);
  ctx.lineTo(x1, -WALL_GAP);
  ctx.moveTo(x0, f.height + WALL_GAP);
  ctx.lineTo(x1, f.height + WALL_GAP);
  ctx.stroke();
  // Gantries across the bay, translucent where they cross the deck.
  ctx.globalAlpha = scene.portAlpha * GANTRY_ALPHA;
  ctx.fillStyle = "#8a9bb0";
  const span = x1 - x0;
  for (const at of [0.22, 0.78]) {
    const x = x0 + span * at;
    rect(ctx, x - 0.4, -WALL_GAP, x + 0.4, f.height + WALL_GAP);
  }
  ctx.globalAlpha = 1;
}

interface Puff {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly opacity: number;
}

/** Fixed cloud bank layout as fractions of one cloud period (positions) and of the deck height. */
const CLOUD_PUFFS: readonly Puff[] = [
  { x: 0.05, y: 0.15, radius: 0.32, opacity: 0.9 },
  { x: 0.18, y: 0.7, radius: 0.4, opacity: 0.8 },
  { x: 0.33, y: 0.35, radius: 0.28, opacity: 1 },
  { x: 0.47, y: 0.9, radius: 0.35, opacity: 0.7 },
  { x: 0.6, y: 0.05, radius: 0.38, opacity: 0.85 },
  { x: 0.72, y: 0.55, radius: 0.3, opacity: 0.9 },
  { x: 0.86, y: 0.25, radius: 0.36, opacity: 0.75 },
  { x: 0.95, y: 0.8, radius: 0.3, opacity: 0.85 },
];

function puff(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rgb: string,
  alpha: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(rx / ry, 1);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
  gradient.addColorStop(0, `rgba(${rgb}, ${alpha})`);
  gradient.addColorStop(0.6, `rgba(${rgb}, ${alpha * 0.55})`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, ry, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawClouds(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  if (scene.cloudBand <= 0) return;
  const { view } = f;
  const period = (view.maxX - view.minX) * 1.4;
  const viewHeight = view.maxY - view.minY;
  for (const cloud of CLOUD_PUFFS) {
    const ry = cloud.radius * viewHeight * 0.6;
    const x = view.minX - ry * 2 + wrap(cloud.x * period + scene.cloudScroll * f.width, period);
    const y = view.minY + cloud.y * viewHeight;
    const alpha = CLOUD_ALPHA * scene.cloudBand * cloud.opacity;
    puff(ctx, x, y, ry * 2.4, ry, scene.palette.cloudRgb, alpha);
  }
}

function drawDust(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  if (scene.dust <= 0) return;
  const spread = 1 + scene.dust * 0.6;
  for (let i = 0; i < 6; i++) {
    const x = (f.width * (i + 0.5)) / 6;
    const r = 2.6 * spread;
    for (const y of [-0.8, f.height + 0.8]) {
      puff(ctx, x, y, r * 1.6, r, scene.palette.dustRgb, DUST_ALPHA * scene.dust);
    }
  }
}

/** Over the deck: bay walls and gantries, or clouds and dust. */
export function drawForeground(ctx: CanvasRenderingContext2D, scene: Scene, f: SceneryFrame): void {
  if (scene.setting === "station") {
    if (scene.portAlpha > 0) drawBayWalls(ctx, scene, f);
    return;
  }
  drawDust(ctx, scene, f);
  drawClouds(ctx, scene, f);
}
