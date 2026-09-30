/**
 * Canvas drawing primitives (PLAN §6 W7). Pure functions over a 2D context — no React, no DOM
 * queries beyond the context — so they're easy to reason about and reuse from tests later.
 * Compartments/walls/doors/machines come from the hardcoded mock geometry (see
 * `worker/mockGeometry.ts` for why); actors/machine state/door state come from the live
 * `RenderFrame`.
 */
import type { DoorPhysicalState, RenderActor, RenderFrame, RenderMachineState } from "@crew/sim";
import {
  DECK_HEIGHT,
  DECK_WIDTH,
  MOCK_COMPARTMENTS,
  MOCK_DOORS,
  MOCK_MACHINES,
} from "../worker/mockGeometry";

export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Fit the `DECK_WIDTH` x `DECK_HEIGHT` tile grid into a CSS-pixel viewport, centred, with padding. */
export function computeFitTransform(
  viewportWidth: number,
  viewportHeight: number,
  padding = 12,
): ViewTransform {
  const availW = Math.max(1, viewportWidth - padding * 2);
  const availH = Math.max(1, viewportHeight - padding * 2);
  const scale = Math.min(availW / DECK_WIDTH, availH / DECK_HEIGHT);
  const offsetX = (viewportWidth - DECK_WIDTH * scale) / 2;
  const offsetY = (viewportHeight - DECK_HEIGHT * scale) / 2;
  return { scale, offsetX, offsetY };
}

function toPx(t: ViewTransform, x: number, y: number): readonly [number, number] {
  return [t.offsetX + x * t.scale, t.offsetY + y * t.scale];
}

const COMPARTMENT_FILL = "#1b2430";
const COMPARTMENT_STROKE = "#3a4a5e";
const WALL_STROKE = "#4d6178";
const TEXT_COLOR = "#e7edf3";
const LABEL_BG = "rgba(10, 14, 20, 0.72)";

const DOOR_COLORS: Record<DoorPhysicalState, string> = {
  closed: "#8a6d3b",
  opening: "#c9a227",
  open: "#4caf6a",
  closing: "#c9a227",
  jammed: "#c0392b",
};

const MACHINE_COLORS: Record<RenderMachineState, string> = {
  ok: "#4caf6a",
  degraded: "#e0a72e",
  failed: "#c0392b",
  off: "#5b6b7a",
};

export function drawCompartments(ctx: CanvasRenderingContext2D, t: ViewTransform): void {
  for (const c of MOCK_COMPARTMENTS) {
    const [x, y] = toPx(t, c.rect.x, c.rect.y);
    const w = c.rect.w * t.scale;
    const h = c.rect.h * t.scale;
    ctx.fillStyle = COMPARTMENT_FILL;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COMPARTMENT_STROKE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    if (t.scale > 10) {
      ctx.fillStyle = "#5c7186";
      ctx.font = `${Math.max(10, t.scale * 0.45)}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(c.name, x + 4, y + 4);
    }
  }
}

/** Walls are the compartment rectangle edges themselves; door gaps get a state-colored bar. */
export function drawWallsAndDoors(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
): void {
  const doorStateById = new Map(frame.doors.map((d) => [d.id, d.physicalState] as const));
  const doorHalfLength = 0.7 * t.scale;
  const doorThickness = Math.max(3, t.scale * 0.22);
  for (const d of MOCK_DOORS) {
    const [cx, cy] = toPx(t, d.x, d.y);
    const state = doorStateById.get(d.id) ?? "closed";
    ctx.strokeStyle = DOOR_COLORS[state];
    ctx.lineWidth = doorThickness;
    ctx.beginPath();
    if (d.orientation === "vertical") {
      ctx.moveTo(cx, cy - doorHalfLength);
      ctx.lineTo(cx, cy + doorHalfLength);
    } else {
      ctx.moveTo(cx - doorHalfLength, cy);
      ctx.lineTo(cx + doorHalfLength, cy);
    }
    ctx.stroke();
  }
  void WALL_STROKE; // walls are the compartment strokes drawn in drawCompartments
}

export function drawMachines(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  selectedId?: string,
): void {
  const stateById = new Map(frame.machines.map((m) => [m.id, m] as const));
  const size = Math.max(8, t.scale * 0.6);
  for (const placement of MOCK_MACHINES) {
    const render = stateById.get(placement.id);
    const state = render?.state ?? "off";
    const [cx, cy] = toPx(t, placement.x, placement.y);
    ctx.fillStyle = MACHINE_COLORS[state];
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    if (selectedId === placement.id) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - size / 2 - 2, cy - size / 2 - 2, size + 4, size + 4);
    }
  }
}

const MIN_DOT_RADIUS = 4; // >= 8px diameter at 390px width, per the brief
const MIN_LABEL_FONT_PX = 11;

function truncateLabel(label: string, maxChars: number): string {
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

export function drawActors(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  selectedId?: string,
): void {
  const radius = Math.max(MIN_DOT_RADIUS, t.scale * 0.22);
  const fontPx = Math.max(MIN_LABEL_FONT_PX, t.scale * 0.32);
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  // Crude collision avoidance: sort by x, offset a label downward for each neighbour whose label
  // would otherwise overlap the previous one's vertical band.
  const sorted = [...frame.actors].sort((a, b) => a.x - b.x);
  const placed: { x: number; y: number; w: number }[] = [];

  for (const actor of sorted) {
    const [cx, cy] = toPx(t, actor.x, actor.y);
    ctx.fillStyle = "#f2c14e";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    if (selectedId === actor.id) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    const label = truncateLabel(`${actor.name} — ${actor.actionLabel}`, 26);
    const labelW = ctx.measureText(label).width + 8;
    let labelY = cy - radius - 6;
    for (const p of placed) {
      if (Math.abs(p.x - cx) < (p.w + labelW) / 2 && Math.abs(p.y - labelY) < fontPx + 4) {
        labelY = p.y - (fontPx + 4);
      }
    }
    placed.push({ x: cx, y: labelY, w: labelW });

    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(cx - labelW / 2, labelY - fontPx / 2 - 2, labelW, fontPx + 4);
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = "center";
    ctx.fillText(label, cx, labelY);
    ctx.textAlign = "left";
  }
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  viewportWidth: number,
  viewportHeight: number,
  selected?: { kind: "actor" | "machine"; id: string },
): void {
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);
  ctx.fillStyle = "#0a0e14";
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);
  drawCompartments(ctx, t);
  drawWallsAndDoors(ctx, t, frame);
  drawMachines(ctx, t, frame, selected?.kind === "machine" ? selected.id : undefined);
  drawActors(ctx, t, frame, selected?.kind === "actor" ? selected.id : undefined);
}

export type { RenderActor };
