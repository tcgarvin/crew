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
import { hashKey, mixHex } from "./color";
import { drawBadge, drawCrate, drawLoadedTruck, itemColor, loadedTruckRise } from "./crates";
import type { DeckLayout } from "./deckLayout";
import { berthInView, dockOrigin, dockSlide, shipInDock, withDockSlide } from "./dock";
import { type DockPaint, drawDock, drawDockForeground } from "./dockArt";
import type { DockTarget } from "./dockHit";
import { dockShape, dockSurface } from "./dockShape";
import { type GrimePaint, drawGrime } from "./grime";
import { type Bounds, type HullGeometry, drawHull, drawPlume } from "./hull";
import { type Flash, drawImpactFlashes } from "./impacts";
import {
  type Box,
  LABEL_COSTS,
  type LabelRequest,
  type LabelText,
  type Obstacle,
  type PlacedLabel,
  boxesOverlap,
  centredBox,
  fitLabelText,
  maxPlateWidth,
  placeLabels,
} from "./labels";
import {
  drawDockProps,
  drawLocalDots,
  drawLocalTrolleys,
  localLabelText,
  localLook,
} from "./locals";
import { drawRamps } from "./ramps";
import { type RockPaint, drawRockLayer } from "./rocks";
import { drawScars } from "./scars";
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
import { firstName, sessionMemberIds, sessionPlateText } from "./sessions";
import { disc } from "./shapes";
import { type ShotTrace, drawShots } from "./shots";
import { type StarLayer, drawStars } from "./stars";

/**
 * Whether the deck's drawing should be turned a quarter (counter-clockwise, bow up) to fill a
 * portrait viewport (task item 5: the deck is landscape 32×18; phones are portrait). Desktop
 * (landscape viewport) never rotates.
 */
export function shouldRotate(
  viewportWidth: number,
  viewportHeight: number,
  layout: Pick<DeckLayout, "width" | "height">,
): boolean {
  return viewportHeight > viewportWidth && layout.width > layout.height;
}

/** Screen padding around the framed bounds, CSS pixels. */
export const FIT_PADDING_PX = 12;
/**
 * A portrait phone keeps every pixel of its width for the ship: the flight margin and the
 * dock map's own edges frame the picture, so the padding is a hairline.
 */
export const PORTRAIT_FIT_PADDING_PX = 4;

/**
 * Fit `bounds` (tile units) into a CSS-pixel viewport, centred, with padding. When `rotated`, the
 * fit is computed against the viewport's dimensions swapped (the deck is drawn in its own
 * landscape space, then the whole canvas is turned a quarter — see `drawFrame`).
 */
export function computeFitTransform(
  viewportWidth: number,
  viewportHeight: number,
  bounds: Bounds,
  rotated: boolean,
  padding = rotated ? PORTRAIT_FIT_PADDING_PX : FIT_PADDING_PX,
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
 * Polish A (§rooms-items-and-cargo): one fill per compartment kind, keyed by the first matching
 * tag. Dark enough for the yellow crew dots and white labels to stay readable, different enough in
 * hue to tell rooms apart on a phone.
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

/**
 * Polish A (§rooms-items-and-cargo): 2px walls along compartment and hull boundaries
 * (doors/openings are gaps).
 */
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

/** A room's name plate where it will be drawn, screen space. */
interface RoomPlate {
  readonly text: string;
  readonly box: Box;
  readonly color: string;
}

/**
 * Compartment names in each room's top-left corner (as seen on screen), each only where its plate
 * fits inside its own room on screen. Measured in the plate font, which is left set.
 */
function roomPlates(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  rotated: boolean,
  viewportHeight: number,
): RoomPlate[] {
  if (t.scale <= 8) return [];
  const fontPx = Math.max(10, Math.min(14, t.scale * 0.42));
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  const roomAt = tileRooms(layout);
  const plates: RoomPlate[] = [];
  for (const [key, name] of Object.entries(layout.compartmentNames)) {
    const box = layout.compartmentBoxes[key];
    if (box === undefined) continue;
    // Under the counter-clockwise turn the screen's top-left of a room is its fit-space
    // top-right corner (bow-most, upper side).
    const [x, y] = rotated
      ? toScreenPx(t, box.maxX, box.minY, true, viewportHeight)
      : toScreenPx(t, box.minX, box.minY, false, viewportHeight);
    const roomWidthPx = (rotated ? box.maxY - box.minY : box.maxX - box.minX) * t.scale;
    const label = fitText(ctx, name.toUpperCase(), roomWidthPx - 10);
    if (label === "") continue;
    const w = ctx.measureText(label).width + 8;
    const h = fontPx + 4;
    // The plate stays inside its own room. In a room shorter than the plate on screen, or
    // one whose bounding-box corner lies in a neighbour, it would cover the neighbour's label.
    const corners = [
      [x + 3, y + 3],
      [x + 2 + w, y + 3],
      [x + 3, y + 2 + h],
      [x + 2 + w, y + 2 + h],
    ] as const;
    const inRoom = corners.every(([cx, cy]) => {
      const at = screenToWorld(t, cx, cy, rotated, viewportHeight);
      return roomAt.get(`${Math.floor(at.x)},${Math.floor(at.y)}`) === key;
    });
    if (!inRoom) continue;
    plates.push({
      text: label,
      box: { left: x + 3, top: y + 3, right: x + 3 + w, bottom: y + 3 + h },
      color: roomStyle(layout.compartmentTags[key]).label,
    });
  }
  return plates;
}

/** Draw the plates, leaving out any a person's label covers (slice-2 QA). */
function drawRoomPlates(
  ctx: CanvasRenderingContext2D,
  plates: readonly RoomPlate[],
  covered: readonly Box[],
): void {
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const plate of plates) {
    if (covered.some((box) => boxesOverlap(box, plate.box))) continue;
    const { left, top, right, bottom } = plate.box;
    ctx.fillStyle = ROOM_PLATE_BG;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.fillStyle = plate.color;
    ctx.fillText(plate.text, left + 4, (top + bottom) / 2);
  }
}

/**
 * Compartment names in each room's top-left corner (as seen on screen) on a subtle plate, drawn in
 * real screen space so text always reads upright (task item 5). Machine labels sit at machine
 * centres, so corner plates keep the two apart. A plate under one of `covered` (people's labels)
 * is left out.
 */
export function drawCompartmentLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  rotated: boolean,
  viewportHeight: number,
  covered: readonly Box[] = [],
): void {
  drawRoomPlates(ctx, roomPlates(ctx, t, layout, rotated, viewportHeight), covered);
}

const tileRoomCache = new WeakMap<DeckLayout, ReadonlyMap<string, string>>();

/** The compartment of each deck tile, by "x,y". */
function tileRooms(layout: DeckLayout): ReadonlyMap<string, string> {
  const cached = tileRoomCache.get(layout);
  if (cached !== undefined) return cached;
  const rooms = new Map<string, string>();
  for (const tile of layout.tiles) {
    if (tile.compartmentKey !== undefined) rooms.set(`${tile.x},${tile.y}`, tile.compartmentKey);
  }
  tileRoomCache.set(layout, rooms);
  return rooms;
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

/** A machine's name where it will be drawn, screen space. */
interface MachineName {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly box: Box;
}

/**
 * Machine short names at machine centres, only "when there is room" (task item 4). Measured in
 * the machine-name font, which is left set.
 */
function machineNames(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  rotated: boolean,
  viewportHeight: number,
): MachineName[] {
  if (t.scale <= 14) return [];
  const fontPx = machineFontPx(t);
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  // Rows of identical machines (four bunks) would print on top of each other: skip a label that
  // would overlap one already placed.
  const names: MachineName[] = [];
  for (const placement of layout.machines) {
    const [cx, cy] = toScreenPx(t, placement.center.x, placement.center.y, rotated, viewportHeight);
    const box = centredBox(cx, cy, ctx.measureText(placement.name).width + 6, fontPx + 2);
    if (names.some((n) => boxesOverlap(n.box, box))) continue;
    names.push({ text: placement.name, x: cx, y: cy, box });
  }
  return names;
}

function machineFontPx(t: ViewTransform): number {
  return Math.max(9, Math.min(13, t.scale * 0.3));
}

/**
 * Machine short-name labels, drawn in real screen space (after any rotation is undone) so text
 * always reads upright, per task item 5. A name under a person's label is left out (slice-2 QA):
 * the label says more, and the two together read as neither.
 */
function drawMachineNames(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  names: readonly MachineName[],
  covered: readonly Box[],
): void {
  ctx.font = `${machineFontPx(t)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const name of names) {
    if (covered.some((box) => boxesOverlap(box, name.box))) continue;
    // Outlined rather than on a plate, so the label never hides the machine it names.
    ctx.strokeStyle = "rgba(5, 7, 10, 0.9)";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeText(name.text, name.x, name.y);
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText(name.text, name.x, name.y);
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

/** How one person's dot is drawn: fill, an optional rim, and a cross over the dead. */
export interface ActorDotLook {
  readonly fill: string;
  readonly rim?: string;
  readonly cross: boolean;
}

/** Grey the down and the dead fade toward, so the fight's still dots read as out of it. */
const OUT_OF_IT = "#5a5f66";

/**
 * Crew gold, the passenger's pale dot with its blue rim, or, for the other side of a fight
 * (expeditions A1, §8.6), a local's muted hue and darker rim (§locals-and-props: never crew gold),
 * stable per person. Someone `down` is dimmed toward grey; someone `dead` more so, with a cross.
 */
export function actorDotLook(
  actor: Pick<RenderActor, "id" | "passenger" | "side" | "state">,
): ActorDotLook {
  const base: { fill: string; rim?: string } =
    actor.side === "them"
      ? localLook(hashKey(actor.id))
      : actor.passenger
        ? { fill: PASSENGER_DOT_COLOR, rim: PASSENGER_RIM_COLOR }
        : { fill: CREW_DOT_COLOR };
  if (actor.state !== "down" && actor.state !== "dead") return { ...base, cross: false };
  const fade = actor.state === "dead" ? 0.75 : 0.5;
  return {
    fill: mixHex(base.fill, OUT_OF_IT, fade),
    ...(base.rim === undefined ? {} : { rim: mixHex(base.rim, OUT_OF_IT, fade) }),
    cross: actor.state === "dead",
  };
}

function drawActorDots(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportHeight: number,
  selectedId?: string,
): void {
  const radius = dotRadius(t);
  for (const actor of frame.actors) {
    const [cx, cy] = toScreenPx(t, actor.x, actor.y, rotated, viewportHeight);
    const look = actorDotLook(actor);
    ctx.fillStyle = look.fill;
    disc(ctx, cx, cy, radius);
    if (look.rim !== undefined) {
      ctx.strokeStyle = look.rim;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (look.cross) {
      const arm = radius * 0.7;
      ctx.strokeStyle = "#1b1d21";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy - arm);
      ctx.lineTo(cx + arm, cy + arm);
      ctx.moveTo(cx + arm, cy - arm);
      ctx.lineTo(cx - arm, cy + arm);
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
    // §offered-freight: crates on offer never pile with taken freight of the same kind, so each
    // reads as itself.
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
 * Items on deck (Polish A, §rooms-items-and-cargo), in screen space so badges stay upright: one
 * filled square per tile pile with a count badge.
 */
export function drawDeckItems(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  layout: DeckLayout,
  frame: RenderFrame,
  rotated: boolean,
  viewportHeight: number,
  selectedId?: string,
): void {
  for (const pile of deckPiles(frame, layout.deckId)) {
    const [cx, cy] = toScreenPx(t, pile.x, pile.y, rotated, viewportHeight);
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

/**
 * §hand-truck-drawing: what rides on each container in the frame (crates on a hand truck), by
 * container id.
 */
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
 * screen; a hand truck with crates on it (§hand-truck-drawing) as the truck and its load. Pocketed
 * rations and the like are not drawn.
 */
export function drawCarriedItems(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportHeight: number,
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
    const [ax, ay] = toScreenPx(t, actor.x, actor.y, rotated, viewportHeight);
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

/**
 * The text over a crew member's or passenger's dot: their first name and nothing else (slice-4
 * playtest). Name and action together crowded the phone view, and the action mostly reads from
 * where the dot is; the inspector says it in full.
 */
export function crewLabelText(actor: Pick<RenderActor, "name">): string {
  return firstName(actor.name);
}

/**
 * Who a label is for, in the order they are placed: a group session's plate (slice 4) first, as
 * it stands for several people; then the crew; the dock's locals last.
 */
const LABEL_RANK = { session: 0, crew: 1, local: 2 } as const;

/** One label over a person's dot (or a session's venue), deck frame. */
interface PersonLabel {
  readonly x: number;
  readonly y: number;
  /** Preferred first. */
  readonly texts: readonly string[];
  readonly rank: (typeof LABEL_RANK)[keyof typeof LABEL_RANK];
  /**
   * The dock's own people (§person-labels) are labelled in a dimmer colour, so the crew read first.
   */
  readonly local: boolean;
  /** Pushing a loaded hand truck or trolley, drawn beside the dot: the label clears its handle. */
  readonly pushing: boolean;
}

/** Ids of the people pushing a hand truck with something on it (§hand-truck-drawing). */
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

/**
 * One plate per group session at its venue (`sessionPlateText`), the crew's labels but for the
 * sessions' members (slice 4, call 17), then the labels of locals doing something
 * (`localLabelText`).
 */
function personLabels(frame: RenderFrame): PersonLabel[] {
  const pushers = truckPushers(frame);
  const members = sessionMemberIds(frame);
  const labels: PersonLabel[] = frame.sessions.map((session) => ({
    x: session.x,
    y: session.y,
    texts: [sessionPlateText(session, frame)],
    rank: LABEL_RANK.session,
    local: false,
    pushing: false,
  }));
  for (const actor of frame.actors) {
    if (members.has(actor.id)) continue;
    labels.push({
      x: actor.x,
      y: actor.y,
      texts: [crewLabelText(actor)],
      rank: LABEL_RANK.crew,
      local: false,
      pushing: pushers.has(actor.id),
    });
  }
  for (const local of frame.locals) {
    const text = localLabelText(local);
    if (text !== undefined) {
      labels.push({
        x: local.x,
        y: local.y,
        texts: [text],
        rank: LABEL_RANK.local,
        local: true,
        pushing: local.carrying > 0,
      });
    }
  }
  return labels;
}

/** A person's label where it will be drawn. */
interface PersonPlate extends PlacedLabel {
  readonly local: boolean;
  readonly dotX: number;
  readonly dotY: number;
}

/** A person label's plate is its text's width plus this. */
const LABEL_PLATE_PAD_PX = 8;

function personFontPx(t: ViewTransform): number {
  return Math.max(MIN_LABEL_FONT_PX, t.scale * 0.32);
}

/**
 * Where each visible person's label goes (`placeLabels`), clear of each other and, where it can, of
 * people's dots and of `obstacles` (room plates, machine names). Crew first, bottom of the screen
 * first, so a crowd's labels fan upward from the lowest; locals (§label-placement) after the crew.
 */
function placePersonLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
  viewportHeight: number,
  obstacles: readonly Obstacle[],
): PersonPlate[] {
  const radius = dotRadius(t);
  const fontPx = personFontPx(t);
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  // A label sits radius + 6 above the dot's centre; a truck's handle rises higher
  // (§label-placement).
  const truckLift = Math.max(0, loadedTruckRise(carriedSize(t)) + fontPx / 2 + 4 - radius - 6);
  const shown = personLabels(frame)
    .map((entry) => ({ entry, at: toScreenPx(t, entry.x, entry.y, rotated, viewportHeight) }))
    // A label names a dot the player can see. While the dock slides in, its people are still
    // off the canvas, and a label clamped onto the edge would float there on its own.
    .filter(({ at: [x, y] }) => x >= 0 && x <= viewportWidth && y >= 0 && y <= viewportHeight)
    .sort((a, b) => a.entry.rank - b.entry.rank || b.at[1] - a.at[1] || a.at[0] - b.at[0]);
  // §label-placement: a plate wider than the canvas is cut to fit, so it never runs off an edge.
  const measure = (text: string) => ctx.measureText(text).width;
  const maxText = maxPlateWidth(viewportWidth) - LABEL_PLATE_PAD_PX;
  const requests: LabelRequest[] = shown.map(({ entry, at: [dotX, dotY] }) => ({
    dotX,
    dotY,
    texts: entry.texts.map((full): LabelText => {
      const text = fitLabelText(full, maxText, measure);
      return { text, width: measure(text) + LABEL_PLATE_PAD_PX };
    }),
    lift: entry.pushing ? truckLift : 0,
  }));
  const space = { viewportWidth, viewportHeight, plateHeight: fontPx + 4, dotRadius: radius };
  return placeLabels(requests, space, obstacles).map((label) => {
    const { entry, at } = shown[label.index] as (typeof shown)[number];
    return { ...label, local: entry.local, dotX: at[0], dotY: at[1] };
  });
}

/** Draw placed person labels, with a thin leader back to the dot for one set away from it. */
function drawPersonPlates(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  plates: readonly PersonPlate[],
): void {
  ctx.font = `${personFontPx(t)}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const plate of plates) {
    const { left, top, right, bottom } = plate.box;
    if (plate.leader) {
      const toX = Math.max(left, Math.min(right, plate.dotX));
      const toY = Math.max(top, Math.min(bottom, plate.dotY));
      ctx.strokeStyle = LEADER_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plate.dotX, plate.dotY);
      ctx.lineTo(toX, toY);
      ctx.stroke();
    }
    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.fillStyle = plate.local ? LOCAL_TEXT_COLOR : TEXT_COLOR;
    ctx.fillText(plate.text, (left + right) / 2, (top + bottom) / 2);
  }
  ctx.textAlign = "left";
}

const LEADER_COLOR = "rgba(231, 237, 243, 0.55)";

/**
 * Name/action labels for the crew and passengers, and for the dock's locals while they are doing
 * something (§person-labels), drawn in real screen space (after any rotation is undone) so text
 * always reads upright, per task item 5. Crowded labels move around their dots and shorten
 * (`placeLabels`). Slice 4: a group session is one plate at its venue in place of its members'
 * labels.
 */
export function drawActorLabels(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  frame: RenderFrame,
  rotated: boolean,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const plates = placePersonLabels(ctx, t, frame, rotated, viewportWidth, viewportHeight, []);
  drawPersonPlates(ctx, t, plates);
}

/**
 * Dockside (§the-scene-outside-the-hull): what `drawFrame` needs for everything outside the deck
 * itself.
 */
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
  /**
   * §dirt-grid: the deck's grime tint, from the dirt frame playback has reached; absent until the
   * first frame arrives, which draws the deck clean.
   */
  readonly grime?: GrimePaint;
  /**
   * §asteroid-field-scars-and-alert: the asteroid field's rock layers, absent while no field is
   * near or fading out (the canvas's `RockFade` is at zero).
   */
  readonly rocks?: RockPaint;
  /**
   * §rock-impacts: impact flashes under way (`ImpactFlashes.active`); absent or empty with none.
   */
  readonly flashes?: readonly Flash[];
  /** Expeditions A1 (§8.6): tracers and hit flashes under way (`ShotTracers.active`). */
  readonly shots?: readonly ShotTrace[];
}

/**
 * What a tap can select: the frame's people, items and machines, the dock's own people (`local`,
 * by id) and staged props (`dockProp`, by `dockPropKey`), a room (§room-tiers: bare deck floor, by
 * compartment key), or a dock post or the dock.
 */
export type DrawSelection =
  | { readonly kind: "actor" | "machine" | "item"; readonly id: string }
  | { readonly kind: "room"; readonly id: string }
  /** §hull-scars-and-ship-loss: a hull scar, by scar id. */
  | { readonly kind: "scar"; readonly id: string }
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
 * One canvas frame, back to front (dockside §2.3): sky, stars, the far rocks
 * (§asteroid-field-scars-and-alert), far scenery, the dock map (or the stand-in berth), plume and
 * hull, the deck (rooms, walls, ramps, doors, machines, hull scars and impact flashes), the
 * foreground and the near rocks; then, upright in screen space, labels, items and people, those on
 * the dock moved with it while it slides (`withDockSlide`). The portrait rotation applies to every
 * layer.
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
    // Draw the deck in its own landscape ("fit") space, then turn the whole thing a quarter
    // counter-clockwise to fill the portrait canvas (task item 5), so the bow points up
    // (§orientation-and-size, `orientation.ts`). See `toScreenPx` for the matching mapping used to
    // place upright text afterwards, and `screenToWorld` for its inverse used for tap-to-select.
    ctx.translate(0, viewportHeight);
    ctx.rotate(-Math.PI / 2);
  }
  inTileSpace(ctx, t, () => drawSky(ctx, scene, sceneryFrame));
  const fitArea = { x: 0, y: 0, width: fitW, height: fitH };
  const { rocks } = scenery;
  drawStars(ctx, scenery.stars, fitArea, scenery.starScrollPx, scene.starSpeed, scene.starAlpha);
  if (rocks !== undefined) drawRockLayer(ctx, rocks.field.far, fitArea, t.scale, rocks);
  const berth = dock === undefined ? undefined : berthInView(dock, layout);
  const dockPaint: DockPaint | undefined =
    berth === undefined
      ? undefined
      : {
          origin: dockOrigin(berth, scene, layout.width),
          ship: shipInDock(berth, layout),
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
  const { grime } = scenery;
  if (grime !== undefined) inTileSpace(ctx, t, () => drawGrime(ctx, layout, grime));
  drawWalls(ctx, t, layout);
  drawDoors(ctx, t, layout, frame);
  drawMachines(ctx, t, layout, frame, selectedIdOf(selected, "machine"));
  inTileSpace(ctx, t, () => {
    // §hull-scars-and-ship-loss: scars on the grime layer's terms (over the floor, under the
    // people), after the machines so a hit machine shows its wound; the flash over both.
    drawScars(ctx, frame.hull.scars, sceneryFrame.px, selectedIdOf(selected, "scar"));
    drawImpactFlashes(ctx, scenery.flashes ?? [], sceneryFrame.px);
    if (dock !== undefined && dockPaint !== undefined) {
      drawDockForeground(ctx, dock, dockPaint, hull.bounds, sceneryFrame.view);
    }
    drawForeground(ctx, scene, sceneryFrame, dock === undefined);
  });
  if (rocks !== undefined) drawRockLayer(ctx, rocks.field.near, fitArea, t.scale, rocks);
  ctx.restore();

  // Everything with text (and the dots and crates that text and badges sit on) is drawn after
  // `ctx.restore()`, in real screen space, so labels stay upright under rotation (task item 5).
  // They sit above the foreground too, so bay walls and clouds never hide the crew.
  // People's labels are placed first, around room plates and machine names where they can be;
  // a plate or a name a label still covers is left out rather than drawn under it (slice-2 QA).
  const plates = roomPlates(ctx, t, layout, rotated, viewportHeight);
  const names = machineNames(ctx, t, layout, rotated, viewportHeight);
  const people = placePersonLabels(ctx, t, shown, rotated, viewportWidth, viewportHeight, [
    ...plates.map((p) => ({ box: p.box, cost: LABEL_COSTS.roomPlate })),
    ...names.map((n) => ({ box: n.box, cost: LABEL_COSTS.machineName })),
  ]);
  const covered = people.map((p) => p.box);
  drawRoomPlates(ctx, plates, covered);
  drawMachineNames(ctx, t, names, covered);
  drawDockProps(
    ctx,
    t,
    shown.dockProps,
    rotated,
    viewportHeight,
    selectedIdOf(selected, "dockProp"),
  );
  drawDeckItems(ctx, t, layout, shown, rotated, viewportHeight, selectedIdOf(selected, "item"));
  drawLocalDots(ctx, t, shown.locals, rotated, viewportHeight, selectedIdOf(selected, "local"));
  drawActorDots(ctx, t, shown, rotated, viewportHeight, selectedIdOf(selected, "actor"));
  drawShots(ctx, t, scenery.shots ?? [], rotated, viewportHeight);
  drawPersonPlates(ctx, t, people);
  // After the labels: a label plate sits just above the dot and would hide the load.
  drawCarriedItems(ctx, t, shown, rotated, viewportHeight);
  drawLocalTrolleys(ctx, t, shown.locals, rotated, viewportHeight);
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
  viewportHeight: number,
): { readonly x: number; readonly y: number } {
  const [lx, ly] = rotated ? [viewportHeight - screenY, screenX] : [screenX, screenY];
  return { x: (lx - t.offsetX) / t.scale, y: (ly - t.offsetY) / t.scale };
}
