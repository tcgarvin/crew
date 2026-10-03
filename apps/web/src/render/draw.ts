/**
 * Canvas drawing primitives (PLAN §6 W7). Pure functions over a 2D context — no React, no DOM
 * queries beyond the context — so they're easy to reason about and reuse from tests later.
 *
 * Integration 1: compartments/doors/machines come from a `DeckLayout` derived from the real
 * `DeckDef` (see `deckLayout.ts`), not the old hardcoded mock geometry. Actors/machine
 * state/door state still come from the live `RenderFrame`.
 */
import type {
  CargoClass,
  DoorPhysicalState,
  RenderActor,
  RenderFrame,
  RenderItem,
  RenderItemKind,
  RenderMachineState,
} from "@crew/sim";
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

const DEFAULT_ROOM = { fill: "#1b2430", label: "#a9b8c8" } as const;

/**
 * Polish A (D28): one fill per compartment kind, keyed by the first matching tag. Dark enough for
 * the yellow crew dots and white labels to stay readable, different enough in hue to tell rooms
 * apart on a phone.
 */
export const ROOM_PALETTE: Readonly<Record<string, { fill: string; label: string }>> = {
  bridge: { fill: "#1c2d4d", label: "#9dbdff" },
  quarters: { fill: "#2c2347", label: "#c7b0ff" },
  galley: { fill: "#3a2b17", label: "#f2c787" },
  infirmary: { fill: "#15393a", label: "#86ddd6" },
  engineering: { fill: "#3d1f20", label: "#ffa596" },
  cargoHold: { fill: "#2a321b", label: "#cfdc8f" },
  corridor: { fill: "#1a2029", label: "#a9b8c8" },
  airlock: { fill: "#183426", label: "#8fe3ae" },
};

export function roomStyle(tags: readonly string[] | undefined): { fill: string; label: string } {
  for (const tag of tags ?? []) {
    const style = ROOM_PALETTE[tag];
    if (style !== undefined) return style;
  }
  return DEFAULT_ROOM;
}

const WALL_COLOR = "#8095ab";
const HULL_COLOR = "#a9bbcd";
const VOID_FILL = "#05070a";
const TEXT_COLOR = "#e7edf3";
const LABEL_BG = "rgba(10, 14, 20, 0.72)";
const ROOM_PLATE_BG = "rgba(5, 7, 10, 0.55)";

const DOOR_COLORS: Record<DoorPhysicalState, string> = {
  closed: "#d19a3a",
  opening: "#e6c64a",
  open: "#4caf6a",
  closing: "#e6c64a",
  jammed: "#e0453a",
};

const MACHINE_COLORS: Record<RenderMachineState, string> = {
  ok: "#3f9a5c",
  degraded: "#e0a72e",
  failed: "#c0392b",
  off: "#5b6b7a",
};

/** Polish A (D28): crate colour per freight class; other kinds get one colour each. */
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

export function drawCompartments(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
): void {
  for (const tile of layout.tiles) {
    const [x, y] = toPx(t, tile.x, tile.y);
    ctx.fillStyle =
      tile.compartmentKey === undefined
        ? VOID_FILL
        : roomStyle(layout.compartmentTags[tile.compartmentKey]).fill;
    // +0.5 overdraw hides hairline seams between tiles at fractional scales.
    ctx.fillRect(x, y, t.scale + 0.5, t.scale + 0.5);
  }
}

/** Polish A (D28): 2px walls along compartment and hull boundaries (doors/openings are gaps). */
export function drawWalls(ctx: CanvasRenderingContext2D, t: ViewTransform, layout: DeckLayout) {
  ctx.lineCap = "square";
  for (const hull of [false, true]) {
    ctx.strokeStyle = hull ? HULL_COLOR : WALL_COLOR;
    ctx.lineWidth = hull ? 3 : 2;
    ctx.beginPath();
    for (const wall of layout.walls) {
      if (wall.hull !== hull) continue;
      const [x1, y1] = toPx(t, wall.x1, wall.y1);
      const [x2, y2] = toPx(t, wall.x2, wall.y2);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }
  ctx.lineCap = "butt";
}

/**
 * Compartment names in each room's top-left corner (as seen on screen) on a subtle plate, drawn in
 * real screen space so text always reads upright (task item 5). Machine labels sit at machine
 * centres, so corner plates keep the two apart.
 */
export function drawCompartmentLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  rotated: boolean,
  viewportWidth: number,
): void {
  if (t.scale <= 8) return;
  const fontPx = Math.max(10, Math.min(14, t.scale * 0.42));
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const [key, name] of Object.entries(layout.compartmentNames)) {
    const box = layout.compartmentBoxes[key];
    if (box === undefined) continue;
    // Under rotation the screen's top-left of a room is its fit-space bottom-left corner.
    const [x, y] = rotated
      ? toScreenPx(t, box.minX, box.maxY, true, viewportWidth)
      : toScreenPx(t, box.minX, box.minY, false, viewportWidth);
    const roomWidthPx = (rotated ? box.maxY - box.minY : box.maxX - box.minX) * t.scale;
    const label = fitText(ctx, name.toUpperCase(), roomWidthPx - 10);
    if (label === "") continue;
    const w = ctx.measureText(label).width + 8;
    const h = fontPx + 4;
    ctx.fillStyle = ROOM_PLATE_BG;
    ctx.fillRect(x + 3, y + 3, w, h);
    ctx.fillStyle = roomStyle(layout.compartmentTags[key]).label;
    ctx.fillText(label, x + 7, y + 3 + h / 2);
  }
}

/** Truncate with an ellipsis to fit `maxPx`; "" if not even two characters fit. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  for (let n = text.length - 1; n >= 2; n--) {
    const candidate = `${text.slice(0, n)}…`;
    if (ctx.measureText(candidate).width <= maxPx) return candidate;
  }
  return "";
}

/**
 * Doors as apertures in the wall (Polish A): the one-tile gap carries a bar in the door-state
 * colour, thick when shut, a thin line when open, so an open door reads as a passage.
 */
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
  const half = 0.5 * t.scale;
  const jamb = Math.max(2, t.scale * 0.12);
  for (const d of layout.doors) {
    const [cx, cy] = toPx(t, d.cx, d.cy);
    const state = stateByKey.get(d.placementKey) ?? "closed";
    const open = state === "open";
    const leaf = half - jamb;
    ctx.strokeStyle = DOOR_COLORS[state];
    ctx.lineWidth = open ? 2 : Math.max(3, t.scale * 0.2);
    ctx.globalAlpha = open ? 0.8 : 1;
    ctx.beginPath();
    if (d.orientation === "vertical") {
      ctx.moveTo(cx, cy - leaf);
      ctx.lineTo(cx, cy + leaf);
    } else {
      ctx.moveTo(cx - leaf, cy);
      ctx.lineTo(cx + leaf, cy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Jambs: short wall stubs either side of the aperture, so the gap reads as a doorway.
    ctx.strokeStyle = d.kind === "ramp" ? HULL_COLOR : WALL_COLOR;
    ctx.lineWidth = d.kind === "ramp" ? 3 : 2;
    ctx.beginPath();
    if (d.orientation === "vertical") {
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx, cy - leaf);
      ctx.moveTo(cx, cy + leaf);
      ctx.lineTo(cx, cy + half);
    } else {
      ctx.moveTo(cx - half, cy);
      ctx.lineTo(cx - leaf, cy);
      ctx.moveTo(cx + leaf, cy);
      ctx.lineTo(cx + half, cy);
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
      const inset = Math.max(1, t.scale * 0.08);
      ctx.fillRect(x + inset, y + inset, t.scale - inset * 2, t.scale - inset * 2);
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
  const fontPx = Math.max(9, Math.min(13, t.scale * 0.3));
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Rows of identical machines (four bunks) would print on top of each other: skip a label that
  // would overlap one already drawn.
  const placed: { x: number; y: number; w: number }[] = [];
  for (const placement of layout.machines) {
    const [cx, cy] = toScreenPx(t, placement.center.x, placement.center.y, rotated, viewportWidth);
    const w = ctx.measureText(placement.name).width + 6;
    if (placed.some((p) => Math.abs(p.x - cx) < (p.w + w) / 2 && Math.abs(p.y - cy) < fontPx + 2)) {
      continue;
    }
    placed.push({ x: cx, y: cy, w });
    // Outlined rather than on a plate, so the label never hides the machine it names.
    ctx.strokeStyle = "rgba(5, 7, 10, 0.9)";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeText(placement.name, cx, cy);
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText(placement.name, cx, cy);
  }
  ctx.textAlign = "left";
}

const MIN_DOT_RADIUS = 4; // >= 8px diameter at 390px width, per the brief

const CREW_DOT_COLOR = "#f2c14e";
/**
 * Passengers §3.2: a paying passenger is a person aboard but not crew, so their dot is a pale
 * one with a blue rim rather than crew yellow. Pale rather than another hue so it never reads as
 * a crate or a machine state on a phone.
 */
const PASSENGER_DOT_COLOR = "#dfe9f3";
const PASSENGER_RIM_COLOR = "#5b86b8";

export function actorDotColor(actor: Pick<RenderActor, "passenger">): string {
  return actor.passenger ? PASSENGER_DOT_COLOR : CREW_DOT_COLOR;
}

export function drawActorDots(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
  selectedId?: string,
): void {
  const radius = Math.max(MIN_DOT_RADIUS, t.scale * 0.22);
  for (const actor of frame.actors) {
    const [cx, cy] = toScreenPx(t, actor.x, actor.y, rotated, viewportWidth);
    ctx.fillStyle = actorDotColor(actor);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    if (actor.passenger) {
      ctx.strokeStyle = PASSENGER_RIM_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (selectedId === actor.id) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Deck items grouped per tile and definition, so a pile of identical crates is one square with a
 * count badge. Several kinds on one tile (freight stowed beside ship's stores) share the tile in
 * quadrants so each stays visible.
 */
export interface ItemPile {
  /** Centre of the pile's square, tile units. */
  readonly x: number;
  readonly y: number;
  /** Side of the square as a fraction of a tile. */
  readonly size: number;
  /** First item in the pile (tap target and colour). */
  readonly top: RenderItem;
  readonly count: number;
}

const QUADRANTS = [
  [0.27, 0.27],
  [0.73, 0.27],
  [0.27, 0.73],
  [0.73, 0.73],
] as const;

export function deckPiles(frame: RenderFrame, deckId: string): ItemPile[] {
  const tiles = new Map<string, Map<string, { top: RenderItem; count: number }>>();
  for (const item of frame.items) {
    const loc = item.location;
    if (loc.kind !== "deck" || loc.deckId !== deckId) continue;
    const tileKey = `${Math.floor(loc.x)},${Math.floor(loc.y)}`;
    let byDef = tiles.get(tileKey);
    if (byDef === undefined) {
      byDef = new Map();
      tiles.set(tileKey, byDef);
    }
    const pile = byDef.get(item.defId);
    if (pile === undefined) byDef.set(item.defId, { top: item, count: item.count });
    else pile.count += item.count;
  }
  const piles: ItemPile[] = [];
  for (const [tileKey, byDef] of tiles) {
    const [tx = 0, ty = 0] = tileKey.split(",").map(Number);
    // Freight first, so it takes the top-left quadrant and the tap target on a crowded tile.
    const sorted = [...byDef.values()].sort(
      (a, b) => Number(b.top.kind === "crate") - Number(a.top.kind === "crate"),
    );
    if (sorted.length === 1 && sorted[0] !== undefined) {
      piles.push({ x: tx + 0.5, y: ty + 0.5, size: 0.6, ...sorted[0] });
      continue;
    }
    sorted.slice(0, QUADRANTS.length).forEach((pile, i) => {
      const [qx, qy] = QUADRANTS[i] ?? [0.5, 0.5];
      piles.push({ x: tx + qx, y: ty + qy, size: 0.42, ...pile });
    });
  }
  return piles;
}

/** A small count tag hung off a crate's top-right corner, so it never hides the crate. */
function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, count: number): void {
  const text = `×${count}`;
  ctx.font = "700 9px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 4;
  const h = 11;
  ctx.fillStyle = "rgba(5, 7, 10, 0.85)";
  ctx.fillRect(x, y - h, w, h);
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 2, y - h / 2 + 0.5);
}

function drawCrate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
  selected: boolean,
): void {
  const x = cx - size / 2;
  const y = cy - size / 2;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = "rgba(10, 14, 20, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, size, size);
  if (size >= 9) {
    // A strap across the lid, so it reads as a crate rather than a machine tile.
    ctx.beginPath();
    ctx.moveTo(x, cy);
    ctx.lineTo(x + size, cy);
    ctx.stroke();
  }
  if (selected) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 3, y - 3, size + 6, size + 6);
  }
}

/**
 * Items on deck (Polish A, D28), in screen space so badges stay upright: one filled square per
 * tile pile with a count badge.
 */
export function drawDeckItems(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
  selectedId?: string,
): void {
  for (const pile of deckPiles(frame, layout.deckId)) {
    const [cx, cy] = toScreenPx(t, pile.x, pile.y, rotated, viewportWidth);
    const size = Math.max(pile.top.kind === "crate" ? 10 : 6, t.scale * pile.size);
    // Ship's stores are drawn dimmer than freight so the cargo reads first.
    ctx.globalAlpha = pile.top.kind === "crate" ? 1 : 0.75;
    drawCrate(ctx, cx, cy, size, itemColor(pile.top), pile.top.id === selectedId);
    ctx.globalAlpha = 1;
    // Freight only: the stores' ration counts are noise at this zoom.
    if (pile.count > 1 && pile.top.kind === "crate") {
      drawBadge(ctx, cx + size / 2, cy - size / 2, pile.count);
    }
  }
}

/**
 * A carried crate or tool as a smaller square riding its carrier's dot, up and to the right on
 * screen. Pocketed rations and the like are not drawn.
 */
export function drawCarriedItems(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
): void {
  const actorsById = new Map(frame.actors.map((a) => [a.id, a] as const));
  const dot = Math.max(MIN_DOT_RADIUS, t.scale * 0.22);
  const small = Math.max(8, t.scale * 0.36);
  for (const item of frame.items) {
    if (item.location.kind !== "carried") continue;
    if (item.kind !== "crate" && item.kind !== "tool") continue;
    const actor = actorsById.get(item.location.actorId);
    if (actor === undefined) continue;
    const [ax, ay] = toScreenPx(t, actor.x, actor.y, rotated, viewportWidth);
    const x = ax + dot + small / 2;
    const y = ay - small * 0.35;
    drawCrate(ctx, x, y, small, itemColor(item), false);
    // A light rim so a carried crate stands out against dark floors and label plates.
    ctx.strokeStyle = "rgba(231, 237, 243, 0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - small / 2 - 1, y - small / 2 - 1, small + 2, small + 2);
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
  selected?: { kind: "actor" | "machine" | "item"; id: string },
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
  drawWalls(ctx, t, layout);
  drawDoors(ctx, t, layout, frame);
  drawMachines(ctx, t, layout, frame, selected?.kind === "machine" ? selected.id : undefined);
  ctx.restore();

  // Everything with text (and the dots and crates that text and badges sit on) is drawn after
  // `ctx.restore()`, in real screen space, so labels stay upright under rotation (task item 5).
  drawCompartmentLabels(ctx, t, layout, rotated, viewportWidth);
  drawMachineLabels(ctx, t, layout, rotated, viewportWidth);
  drawDeckItems(
    ctx,
    t,
    layout,
    frame,
    rotated,
    viewportWidth,
    selected?.kind === "item" ? selected.id : undefined,
  );
  drawActorDots(
    ctx,
    t,
    frame,
    rotated,
    viewportWidth,
    selected?.kind === "actor" ? selected.id : undefined,
  );
  drawActorLabels(ctx, t, frame, rotated, viewportWidth);
  // After the labels: a label plate sits just above the dot and would hide the load.
  drawCarriedItems(ctx, t, frame, rotated, viewportWidth);
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
