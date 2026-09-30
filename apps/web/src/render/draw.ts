/**
 * Canvas drawing primitives (PLAN §6 W7). Pure functions over a 2D context — no React, no DOM
 * queries beyond the context — so they're easy to reason about and reuse from tests later.
 *
 * Integration 1: compartments/doors/machines come from a `DeckLayout` derived from the real
 * `DeckDef` (see `deckLayout.ts`), not the old hardcoded mock geometry. Actors/machine
 * state/door state still come from the live `RenderFrame`.
 */
import type { DoorPhysicalState, RenderFrame, RenderMachineState } from "@crew/sim";
import type { DeckLayout } from "./deckLayout";

export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Whether the deck's drawing should be rotated 90° to fill a portrait viewport (task item 5:
 * the deck is landscape 32×18; phones are portrait). Desktop (landscape viewport) never rotates.
 */
export function shouldRotate(
  viewportWidth: number,
  viewportHeight: number,
  layout: Pick<DeckLayout, "width" | "height">,
): boolean {
  return viewportHeight > viewportWidth && layout.width > layout.height;
}

/**
 * Fit the deck's tile grid into a CSS-pixel viewport, centred, with padding. When `rotated`, the
 * fit is computed against the viewport's dimensions swapped (the deck is drawn in its own
 * landscape space, then the whole canvas is rotated 90° — see `drawFrame`).
 */
export function computeFitTransform(
  viewportWidth: number,
  viewportHeight: number,
  layout: Pick<DeckLayout, "width" | "height">,
  rotated: boolean,
  padding = 12,
): ViewTransform {
  const fitW = rotated ? viewportHeight : viewportWidth;
  const fitH = rotated ? viewportWidth : viewportHeight;
  const availW = Math.max(1, fitW - padding * 2);
  const availH = Math.max(1, fitH - padding * 2);
  const scale = Math.min(availW / layout.width, availH / layout.height);
  const offsetX = (fitW - layout.width * scale) / 2;
  const offsetY = (fitH - layout.height * scale) / 2;
  return { scale, offsetX, offsetY };
}

function toPx(t: ViewTransform, x: number, y: number): readonly [number, number] {
  return [t.offsetX + x * t.scale, t.offsetY + y * t.scale];
}

/**
 * Map a point in the transform's local ("fit") space to real screen pixels, applying the same
 * 90° rotation `drawFrame` applies to the canvas — used to place text after `ctx.restore()` so
 * labels stay upright (task item 5).
 */
function toScreenPx(
  t: ViewTransform,
  x: number,
  y: number,
  rotated: boolean,
  viewportWidth: number,
): readonly [number, number] {
  const [lx, ly] = toPx(t, x, y);
  if (!rotated) return [lx, ly];
  // Matches the canvas transform in `drawFrame`: translate(viewportWidth, 0); rotate(90deg).
  return [viewportWidth - ly, lx];
}

const COMPARTMENT_FILL = "#1b2430";
const COMPARTMENT_STROKE = "#3a4a5e";
const VOID_FILL = "#05070a";
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

export function drawCompartments(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
): void {
  const byXY = new Map<string, string | undefined>();
  for (const tile of layout.tiles) byXY.set(`${tile.x},${tile.y}`, tile.compartmentKey);

  for (const tile of layout.tiles) {
    const [x, y] = toPx(t, tile.x, tile.y);
    const w = t.scale;
    const h = t.scale;
    ctx.fillStyle = tile.compartmentKey === undefined ? VOID_FILL : COMPARTMENT_FILL;
    ctx.fillRect(x, y, w + 0.5, h + 0.5);

    if (tile.compartmentKey === undefined) continue;
    ctx.strokeStyle = COMPARTMENT_STROKE;
    ctx.lineWidth = 1;
    // Only stroke edges where the neighbouring tile belongs to a different compartment (or is
    // void), so interior tile seams within one compartment stay invisible.
    const right = byXY.get(`${tile.x + 1},${tile.y}`);
    const down = byXY.get(`${tile.x},${tile.y + 1}`);
    if (right !== tile.compartmentKey) {
      ctx.beginPath();
      ctx.moveTo(x + w + 0.5, y);
      ctx.lineTo(x + w + 0.5, y + h + 0.5);
      ctx.stroke();
    }
    if (down !== tile.compartmentKey) {
      ctx.beginPath();
      ctx.moveTo(x, y + h + 0.5);
      ctx.lineTo(x + w + 0.5, y + h + 0.5);
      ctx.stroke();
    }
  }
}

/**
 * Compartment name labels, drawn in real screen space (after any rotation is undone) so text
 * always reads upright, per task item 5.
 */
export function drawCompartmentLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  rotated: boolean,
  viewportWidth: number,
): void {
  if (t.scale <= 10) return;
  ctx.fillStyle = "#5c7186";
  ctx.font = `${Math.max(10, t.scale * 0.45)}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const [key, name] of Object.entries(layout.compartmentNames)) {
    const bound = layout.compartmentBounds[key];
    if (bound === undefined) continue;
    const [x, y] = toScreenPx(t, bound.x, bound.y, rotated, viewportWidth);
    ctx.fillText(name, x + 4, y + 4);
  }
}

export function drawDoors(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  frame: RenderFrame,
): void {
  const stateByKey = new Map(
    frame.doors
      .filter((d) => d.deckId === layout.deckId)
      .map((d) => [d.placementKey, d.physicalState] as const),
  );
  const doorHalfLength = 0.7 * t.scale;
  const doorThickness = Math.max(3, t.scale * 0.22);
  for (const d of layout.doors) {
    const [cx, cy] = toPx(t, d.cx, d.cy);
    const state = stateByKey.get(d.placementKey) ?? "closed";
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
}

export function drawMachines(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  frame: RenderFrame,
  selectedId?: string,
): void {
  const stateByKey = new Map(
    frame.machines
      .filter((m) => m.deckId === layout.deckId)
      .map((m) => [m.placementKey, m] as const),
  );
  for (const placement of layout.machines) {
    const render = stateByKey.get(placement.placementKey);
    const state = render?.state ?? "off";
    ctx.fillStyle = MACHINE_COLORS[state];
    for (const tile of placement.footprint) {
      const [x, y] = toPx(t, tile.x, tile.y);
      ctx.fillRect(x + 1, y + 1, t.scale - 2, t.scale - 2);
    }
    if (render !== undefined && selectedId === render.id) {
      const minX = Math.min(...placement.footprint.map((f) => f.x));
      const minY = Math.min(...placement.footprint.map((f) => f.y));
      const maxX = Math.max(...placement.footprint.map((f) => f.x)) + 1;
      const maxY = Math.max(...placement.footprint.map((f) => f.y)) + 1;
      const [x, y] = toPx(t, minX, minY);
      const w = (maxX - minX) * t.scale;
      const h = (maxY - minY) * t.scale;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    }
  }
}

/**
 * Machine short-name labels, drawn in real screen space (after any rotation is undone) so text
 * always reads upright, per task item 5. Only drawn "when there is room" (task item 4).
 */
export function drawMachineLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  rotated: boolean,
  viewportWidth: number,
): void {
  if (t.scale <= 14) return;
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `${Math.max(9, t.scale * 0.3)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const placement of layout.machines) {
    const [cx, cy] = toScreenPx(t, placement.center.x, placement.center.y, rotated, viewportWidth);
    ctx.fillText(placement.name, cx, cy);
  }
  ctx.textAlign = "left";
}

const MIN_DOT_RADIUS = 4; // >= 8px diameter at 390px width, per the brief

export function drawActorDots(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  selectedId?: string,
): void {
  const radius = Math.max(MIN_DOT_RADIUS, t.scale * 0.22);
  for (const actor of frame.actors) {
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
  }
}

const MIN_LABEL_FONT_PX = 11;

function truncateLabel(label: string, maxChars: number): string {
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

/**
 * Actor name/action labels, drawn in real screen space (after any rotation is undone) so text
 * always reads upright, per task item 5.
 */
export function drawActorLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
): void {
  const radius = Math.max(MIN_DOT_RADIUS, t.scale * 0.22);
  const fontPx = Math.max(MIN_LABEL_FONT_PX, t.scale * 0.32);
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  const sorted = [...frame.actors].sort((a, b) => a.x - b.x);
  const placed: { x: number; y: number; w: number }[] = [];

  for (const actor of sorted) {
    const [cx, cy] = toScreenPx(t, actor.x, actor.y, rotated, viewportWidth);
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
  layout: DeckLayout,
  frame: RenderFrame,
  viewportWidth: number,
  viewportHeight: number,
  rotated: boolean,
  selected?: { kind: "actor" | "machine"; id: string },
): void {
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);
  ctx.fillStyle = "#0a0e14";
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  ctx.save();
  if (rotated) {
    // Draw the deck in its own landscape ("fit") space, then rotate the whole thing 90°
    // clockwise to fill the portrait canvas (task item 5). See `toScreenPx` for the matching
    // inverse used to place upright text afterwards, and `screenToWorld` for the matching
    // inverse used for tap-to-select.
    ctx.translate(viewportWidth, 0);
    ctx.rotate(Math.PI / 2);
  }
  drawCompartments(ctx, t, layout);
  drawDoors(ctx, t, layout, frame);
  drawMachines(ctx, t, layout, frame, selected?.kind === "machine" ? selected.id : undefined);
  drawActorDots(ctx, t, frame, selected?.kind === "actor" ? selected.id : undefined);
  ctx.restore();

  // All text after `ctx.restore()`, in real screen space, so labels stay upright under rotation
  // (task item 5).
  drawCompartmentLabels(ctx, t, layout, rotated, viewportWidth);
  drawMachineLabels(ctx, t, layout, rotated, viewportWidth);
  drawActorLabels(ctx, t, frame, rotated, viewportWidth);
}

/**
 * Inverse of the transform `drawFrame` applies, for tap-to-select: screen pixels -> deck tile
 * units. Mirrors `toScreenPx`'s forward mapping.
 */
export function screenToWorld(
  t: ViewTransform,
  screenX: number,
  screenY: number,
  rotated: boolean,
  viewportWidth: number,
): { readonly x: number; readonly y: number } {
  const [lx, ly] = rotated ? [screenY, viewportWidth - screenX] : [screenX, screenY];
  return { x: (lx - t.offsetX) / t.scale, y: (ly - t.offsetY) / t.scale };
}

export type { DeckLayout };
