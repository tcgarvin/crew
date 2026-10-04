/**
 * Canvas drawing primitives (PLAN §6 W7). Pure functions over a 2D context — no React, no DOM
 * queries beyond the context — so they're easy to reason about and reuse from tests later.
 *
 * Integration 1: compartments/doors/machines come from a `DeckLayout` derived from the real
 * `DeckDef` (see `deckLayout.ts`), not the old hardcoded mock geometry. Actors/machine
 * state/door state still come from the live `RenderFrame`.
 */
import type {
  DockDef,
  DoorPhysicalState,
  RenderActor,
  RenderFrame,
  RenderItem,
  RenderMachineState,
} from "@crew/sim";
import { drawBadge, drawCrate, drawLoadedTruck, itemColor, loadedTruckRise } from "./crates";
import type { DeckLayout } from "./deckLayout";
import { berthInView, dockOrigin, dockSlide, withDockSlide } from "./dock";
import { type DockPaint, drawDock, drawDockForeground } from "./dockArt";
import type { DockTarget } from "./dockHit";
import { dockShape, dockSurface } from "./dockShape";
import { type Bounds, type HullGeometry, drawHull, drawPlume } from "./hull";
import { drawDockProps, drawLocalDots, drawLocalTrolleys, localLabelText } from "./locals";
import { drawRamps } from "./ramps";
import type { Scene } from "./scene";
import {
  type SceneryFrame,
  drawBerth,
  drawFarScenery,
  drawForeground,
  drawPlanetBelow,
  drawSky,
} from "./scenery";
import { TEXT_COLOR, type ViewTransform, carriedSize, dotRadius, toPx, toScreenPx } from "./screen";
import { disc } from "./shapes";
import { type StarLayer, drawStars } from "./stars";

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
 * Fit `bounds` (tile units) into a CSS-pixel viewport, centred, with padding. When `rotated`, the
 * fit is computed against the viewport's dimensions swapped (the deck is drawn in its own
 * landscape space, then the whole canvas is rotated 90° — see `drawFrame`).
 */
export function computeFitTransform(
  viewportWidth: number,
  viewportHeight: number,
  bounds: Bounds,
  rotated: boolean,
  padding = 12,
): ViewTransform {
  const fitW = rotated ? viewportHeight : viewportWidth;
  const fitH = rotated ? viewportWidth : viewportHeight;
  const availW = Math.max(1, fitW - padding * 2);
  const availH = Math.max(1, fitH - padding * 2);
  const boundsW = bounds.maxX - bounds.minX;
  const boundsH = bounds.maxY - bounds.minY;
  const scale = Math.min(availW / boundsW, availH / boundsH);
  const offsetX = (fitW - boundsW * scale) / 2 - bounds.minX * scale;
  const offsetY = (fitH - boundsH * scale) / 2 - bounds.minY * scale;
  return { scale, offsetX, offsetY };
}

const DEFAULT_ROOM = { fill: "#1b2430", label: "#a9b8c8" } as const;

/**
 * Polish A (D28): one fill per compartment kind, keyed by the first matching tag. Dark enough for
 * the yellow crew dots and white labels to stay readable, different enough in hue to tell rooms
 * apart on a phone.
 */
const ROOM_PALETTE: Readonly<Record<string, { fill: string; label: string }>> = {
  bridge: { fill: "#1c2d4d", label: "#9dbdff" },
  quarters: { fill: "#2c2347", label: "#c7b0ff" },
  galley: { fill: "#3a2b17", label: "#f2c787" },
  infirmary: { fill: "#15393a", label: "#86ddd6" },
  engineering: { fill: "#3d1f20", label: "#ffa596" },
  cargoHold: { fill: "#2a321b", label: "#cfdc8f" },
  corridor: { fill: "#1a2029", label: "#a9b8c8" },
  airlock: { fill: "#183426", label: "#8fe3ae" },
};

function roomStyle(tags: readonly string[] | undefined): { fill: string; label: string } {
  for (const tag of tags ?? []) {
    const style = ROOM_PALETTE[tag];
    if (style !== undefined) return style;
  }
  return DEFAULT_ROOM;
}

const WALL_COLOR = "#8095ab";
const HULL_COLOR = "#a9bbcd";
const VOID_FILL = "#05070a";
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

function drawCompartments(
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
function drawWalls(ctx: CanvasRenderingContext2D, t: ViewTransform, layout: DeckLayout) {
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
function drawCompartmentLabels(
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
function drawDoors(
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

function drawMachines(
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
function drawMachineLabels(
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

export const CREW_DOT_COLOR = "#f2c14e";
/**
 * Passengers §3.2: a paying passenger is a person aboard but not crew, so their dot is a pale
 * one with a blue rim rather than crew yellow. Pale rather than another hue so it never reads as
 * a crate or a machine state on a phone.
 */
export const PASSENGER_DOT_COLOR = "#dfe9f3";
export const PASSENGER_RIM_COLOR = "#5b86b8";

export function actorDotColor(actor: Pick<RenderActor, "passenger">): string {
  return actor.passenger ? PASSENGER_DOT_COLOR : CREW_DOT_COLOR;
}

function drawActorDots(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
  selectedId?: string,
): void {
  const radius = dotRadius(t);
  for (const actor of frame.actors) {
    const [cx, cy] = toScreenPx(t, actor.x, actor.y, rotated, viewportWidth);
    ctx.fillStyle = actorDotColor(actor);
    disc(ctx, cx, cy, radius);
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
    // D63: crates on offer never pile with taken freight of the same kind, so each reads as itself.
    const pileKey = item.offered === true ? `${item.defId}/offered` : item.defId;
    const pile = byDef.get(pileKey);
    if (pile === undefined) byDef.set(pileKey, { top: item, count: item.count });
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
    drawCrate(
      ctx,
      cx,
      cy,
      size,
      itemColor(pile.top),
      pile.top.id === selectedId,
      pile.top.offered === true,
    );
    ctx.globalAlpha = 1;
    // Freight only: the stores' ration counts are noise at this zoom.
    if (pile.count > 1 && pile.top.kind === "crate") {
      drawBadge(ctx, cx + size / 2, cy - size / 2, pile.count);
    }
  }
}

/** D65: what rides on each container in the frame (crates on a hand truck), by container id. */
function containerLoads(frame: RenderFrame): Map<string, RenderItem[]> {
  const loads = new Map<string, RenderItem[]>();
  for (const item of frame.items) {
    if (item.location.kind !== "container") continue;
    const id = item.location.containerId;
    loads.set(id, [...(loads.get(id) ?? []), item]);
  }
  return loads;
}

/**
 * A carried crate or tool as a smaller square riding its carrier's dot, up and to the right on
 * screen; a hand truck with crates on it (D65) as the truck and its load. Pocketed rations and
 * the like are not drawn.
 */
export function drawCarriedItems(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
): void {
  const actorsById = new Map(frame.actors.map((a) => [a.id, a] as const));
  const dot = dotRadius(t);
  const small = carriedSize(t);
  const loads = containerLoads(frame);
  for (const item of frame.items) {
    if (item.location.kind !== "carried") continue;
    if (item.kind !== "crate" && item.kind !== "tool") continue;
    const actor = actorsById.get(item.location.actorId);
    if (actor === undefined) continue;
    const [ax, ay] = toScreenPx(t, actor.x, actor.y, rotated, viewportWidth);
    const x = ax + dot + small / 2;
    const y = ay - small * 0.35;
    const load = loads.get(item.id);
    if (load !== undefined) {
      drawLoadedTruck(
        ctx,
        x,
        ay,
        small,
        load.map((crate) => itemColor(crate)),
      );
      continue;
    }
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

/** D70: the captain ashore meeting someone; the label names them. */
const MEETING_LABEL = /^(talking with|going to see|ashore to see) (\S+)/;

/**
 * The text over a crew member's dot: name and what they are doing, cut to 26 characters. D70: a
 * label that names who they are meeting ("talking with Fenwick Adair") keeps the verb and that
 * person's first name, up to a local's 34 (D68), so the meeting reads rather than an ellipsis.
 */
export function crewLabelText(actor: Pick<RenderActor, "name" | "actionLabel">): string {
  const meeting = MEETING_LABEL.exec(actor.actionLabel);
  if (meeting !== null) return truncateLabel(`${actor.name} — ${meeting[1]} ${meeting[2]}`, 34);
  return truncateLabel(`${actor.name} — ${actor.actionLabel}`, 26);
}

/** One label over a person's dot, deck frame. */
interface PersonLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** The dock's own people (D68) are labelled in a dimmer colour, so the crew read first. */
  readonly local: boolean;
  /** Pushing a loaded hand truck or trolley, drawn beside the dot: the label clears its handle. */
  readonly pushing: boolean;
}

/** Ids of the people pushing a hand truck with something on it (D65). */
function truckPushers(frame: RenderFrame): Set<string> {
  const loads = containerLoads(frame);
  const pushers = new Set<string>();
  for (const item of frame.items) {
    if (item.location.kind === "carried" && loads.has(item.id)) {
      pushers.add(item.location.actorId);
    }
  }
  return pushers;
}

const LOCAL_TEXT_COLOR = "#b9c4cf";

/** The crew's labels, then the labels of locals doing something (`localLabelText`). */
function personLabels(frame: RenderFrame): PersonLabel[] {
  const pushers = truckPushers(frame);
  const labels: PersonLabel[] = frame.actors.map((actor) => ({
    x: actor.x,
    y: actor.y,
    text: crewLabelText(actor),
    local: false,
    pushing: pushers.has(actor.id),
  }));
  for (const local of frame.locals) {
    const text = localLabelText(local);
    if (text !== undefined) {
      labels.push({
        x: local.x,
        y: local.y,
        text: truncateLabel(text, 34),
        local: true,
        pushing: local.carrying > 0,
      });
    }
  }
  return labels;
}

/**
 * Name/action labels for the crew and passengers, and for the dock's locals while they are doing
 * something (D68), drawn in real screen space (after any rotation is undone) so text always reads
 * upright, per task item 5. Overlapping labels stack upward.
 */
export function drawActorLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
): void {
  const radius = dotRadius(t);
  const fontPx = Math.max(MIN_LABEL_FONT_PX, t.scale * 0.32);
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  const sorted = personLabels(frame).sort((a, b) => a.x - b.x);
  const placed: { x: number; y: number; w: number }[] = [];
  // A label sits radius + 6 above the dot's centre; a truck's handle rises higher (D68 check).
  const truckLift = Math.max(0, loadedTruckRise(carriedSize(t)) + fontPx / 2 + 4 - radius - 6);

  for (const entry of sorted) {
    const [dotX, cy] = toScreenPx(t, entry.x, entry.y, rotated, viewportWidth);
    const labelW = ctx.measureText(entry.text).width + 8;
    // Kept on screen: the docked camera puts people on the dock's far edges.
    const cx = Math.max(labelW / 2 + 2, Math.min(viewportWidth - labelW / 2 - 2, dotX));
    let labelY = cy - radius - 6 - (entry.pushing ? truckLift : 0);
    for (const p of placed) {
      if (Math.abs(p.x - cx) < (p.w + labelW) / 2 && Math.abs(p.y - labelY) < fontPx + 4) {
        labelY = p.y - (fontPx + 4);
      }
    }
    placed.push({ x: cx, y: labelY, w: labelW });

    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(cx - labelW / 2, labelY - fontPx / 2 - 2, labelW, fontPx + 4);
    ctx.fillStyle = entry.local ? LOCAL_TEXT_COLOR : TEXT_COLOR;
    ctx.textAlign = "center";
    ctx.fillText(entry.text, cx, labelY);
    ctx.textAlign = "left";
  }
}

/** Dockside (D58): what `drawFrame` needs for everything outside the deck itself. */
export interface Scenery {
  readonly scene: Scene;
  readonly hull: HullGeometry;
  readonly stars: readonly StarLayer[];
  /** The client star accumulator's offset, CSS pixels. */
  readonly starScrollPx: number;
  /** Scene plume times the engines' output. */
  readonly plume: number;
  /** -1..1 wobble for the plume (0 under reduced motion). */
  readonly flicker: number;
  /**
   * Phase 2: the dock map for the port in view (`dockInView`), or `undefined` when the port has
   * none, which draws the phase 1 stand-in berth and bay walls instead.
   */
  readonly dock: DockDef | undefined;
  /** Docking clamps, 0 retracted to 1 engaged (`clampEngagement`). */
  readonly clamps: number;
}

/**
 * What a tap can select: the frame's people, items and machines, the dock's own people (`local`,
 * by id) and staged props (`dockProp`, by `dockPropKey`), or a dock post or the dock.
 */
export type DrawSelection =
  | { readonly kind: "actor" | "machine" | "item"; readonly id: string }
  | { readonly kind: "local"; readonly id: string }
  | { readonly kind: "dockProp"; readonly id: string }
  | DockTarget;

/** The id of `selected` when it is of `kind`, for the layer that draws that kind's highlight. */
function selectedIdOf(
  selected: DrawSelection | undefined,
  kind: DrawSelection["kind"],
): string | undefined {
  return selected?.kind === kind ? selected.id : undefined;
}

/** The fit-space rectangle the canvas shows, in tile units. */
function visibleTiles(t: ViewTransform, fitW: number, fitH: number): Bounds {
  return {
    minX: -t.offsetX / t.scale,
    minY: -t.offsetY / t.scale,
    maxX: (fitW - t.offsetX) / t.scale,
    maxY: (fitH - t.offsetY) / t.scale,
  };
}

/** Run `draw` with the context in deck tile units (inside any rotation already applied). */
function inTileSpace(ctx: CanvasRenderingContext2D, t: ViewTransform, draw: () => void): void {
  ctx.save();
  ctx.translate(t.offsetX, t.offsetY);
  ctx.scale(t.scale, t.scale);
  draw();
  ctx.restore();
}

/**
 * One canvas frame, back to front (dockside §2.3): sky, stars, far scenery, the dock map (or the
 * stand-in berth), plume and hull, the deck (rooms, walls, ramps, doors, machines), the
 * foreground; then, upright in screen space, labels, items and people, those on the dock moved
 * with it while it slides (`withDockSlide`). The portrait rotation applies to every layer.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  frame: RenderFrame,
  viewportWidth: number,
  viewportHeight: number,
  rotated: boolean,
  scenery: Scenery,
  selected?: DrawSelection,
): void {
  const { scene, hull, dock } = scenery;
  const shown = dock === undefined ? frame : withDockSlide(frame, dockSlide(scene, layout.width));
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);
  ctx.fillStyle = scene.skyColor;
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  const fitW = rotated ? viewportHeight : viewportWidth;
  const fitH = rotated ? viewportWidth : viewportHeight;
  const sceneryFrame: SceneryFrame = {
    width: layout.width,
    height: layout.height,
    view: visibleTiles(t, fitW, fitH),
    px: 1 / t.scale,
  };

  ctx.save();
  if (rotated) {
    // Draw the deck in its own landscape ("fit") space, then rotate the whole thing 90°
    // clockwise to fill the portrait canvas (task item 5). See `toScreenPx` for the matching
    // inverse used to place upright text afterwards, and `screenToWorld` for the matching
    // inverse used for tap-to-select.
    ctx.translate(viewportWidth, 0);
    ctx.rotate(Math.PI / 2);
  }
  inTileSpace(ctx, t, () => drawSky(ctx, scene, sceneryFrame));
  drawStars(
    ctx,
    scenery.stars,
    { x: 0, y: 0, width: fitW, height: fitH },
    scenery.starScrollPx,
    scene.starSpeed,
    scene.starAlpha,
  );
  const dockPaint: DockPaint | undefined =
    dock === undefined
      ? undefined
      : {
          origin: dockOrigin(berthInView(dock, layout), scene, layout.width),
          alpha: scene.portAlpha,
          clamps: scenery.clamps,
          setting: scene.setting,
          px: sceneryFrame.px,
          view: sceneryFrame.view,
          enclosure: scene.cameraT,
          ...(selected?.kind === "post" ? { selectedPostKey: selected.id } : {}),
        };
  inTileSpace(ctx, t, () => {
    drawFarScenery(ctx, scene, sceneryFrame);
    if (dock === undefined || dockPaint === undefined) {
      drawBerth(ctx, scene, sceneryFrame);
    } else {
      drawPlanetBelow(
        ctx,
        scene,
        sceneryFrame,
        dockSurface(dockShape(dock), scene.setting).overSky,
      );
      drawDock(ctx, dock, dockPaint);
    }
    drawPlume(ctx, hull, scenery.plume, scenery.flicker);
    drawHull(ctx, hull, sceneryFrame.px);
    drawRamps(ctx, layout, frame, sceneryFrame.px);
  });
  drawCompartments(ctx, t, layout);
  drawWalls(ctx, t, layout);
  drawDoors(ctx, t, layout, frame);
  drawMachines(ctx, t, layout, frame, selectedIdOf(selected, "machine"));
  inTileSpace(ctx, t, () => {
    if (dock !== undefined && dockPaint !== undefined) {
      drawDockForeground(ctx, dock, dockPaint, hull.bounds, sceneryFrame.view);
    }
    drawForeground(ctx, scene, sceneryFrame, dock === undefined);
  });
  ctx.restore();

  // Everything with text (and the dots and crates that text and badges sit on) is drawn after
  // `ctx.restore()`, in real screen space, so labels stay upright under rotation (task item 5).
  // They sit above the foreground too, so bay walls and clouds never hide the crew.
  drawCompartmentLabels(ctx, t, layout, rotated, viewportWidth);
  drawMachineLabels(ctx, t, layout, rotated, viewportWidth);
  drawDockProps(
    ctx,
    t,
    shown.dockProps,
    rotated,
    viewportWidth,
    selectedIdOf(selected, "dockProp"),
  );
  drawDeckItems(ctx, t, layout, shown, rotated, viewportWidth, selectedIdOf(selected, "item"));
  drawLocalDots(ctx, t, shown.locals, rotated, viewportWidth, selectedIdOf(selected, "local"));
  drawActorDots(ctx, t, shown, rotated, viewportWidth, selectedIdOf(selected, "actor"));
  drawActorLabels(ctx, t, shown, rotated, viewportWidth);
  // After the labels: a label plate sits just above the dot and would hide the load.
  drawCarriedItems(ctx, t, shown, rotated, viewportWidth);
  drawLocalTrolleys(ctx, t, shown.locals, rotated, viewportWidth);
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
