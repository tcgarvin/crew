/**
 * Dockside §2.3 layers 4 and 7 (phase 2): the dock map, drawn procedurally in its own palette.
 *
 * - `drawDock` (layer 4, behind the hull): void, the berth, floor, walls, the staging and delivery
 *   markings, the quay's edge and its clamps, the posts and the props.
 * - `drawDockForeground` (layer 7, over the deck): bay walls, gantries, the terminal's edge,
 *   awnings and rock, each translucent where it crosses the ship so the crew stay legible.
 *
 * Both draw in deck tile units (the caller's tile-space transform, inside the portrait rotation)
 * with the dock map's tile (0,0) at `origin`, which carries the berth offset, so the whole map
 * slides with the scene. People and loose items on the dock are drawn later, in screen space,
 * by `drawFrame` (see `withDockSlide`).
 */
import type {
  DockAreaKind,
  DockDef,
  DockForegroundDef,
  DockForegroundKind,
  DockPostDef,
  DockPostKind,
  DockRect,
  EdgeSide,
  PortSetting,
  TileCoord,
} from "@crew/sim";
import { BLACK, WHITE, hash01, mixHex, rgba } from "./color";
import { type PropLook, drawProp } from "./dockProps";
import {
  type DockShape,
  type FloorPattern,
  type TileRun,
  dockShape,
  dockSurface,
} from "./dockShape";
import { type Bounds, HULL_RIM } from "./hull";
import { disc, segment, withClipRect } from "./shapes";

/** What the dock layer needs besides the map. */
export interface DockPaint {
  /** Deck-frame position of the map's tile (0,0), slide included. */
  readonly origin: TileCoord;
  /** Opacity of the whole map (the reduced-motion cross-fade). */
  readonly alpha: number;
  /** Docking clamps, 0 retracted to 1 engaged. */
  readonly clamps: number;
  /** The dock's port is a station or a planet (D61: the setting is the port's, not the map's). */
  readonly setting: PortSetting;
  /** One CSS pixel in tile units. */
  readonly px: number;
  /** The visible area, deck tile units. */
  readonly view: Bounds;
  /**
   * 0..1: how far a station bay's darkness fills the view beyond the map (the scene's
   * `cameraT`, so it closes in as the camera settles on the dock and opens as it leaves).
   */
  readonly enclosure: number;
  /** A tapped post, outlined. */
  readonly selectedPostKey?: string;
}

/** Bay space at a station: a pit a little darker than the walls. Planets show the sky instead. */
function pitColor(dock: DockDef): string {
  return mixHex(dock.palette.wall, BLACK, 0.55);
}

function fillRuns(ctx: CanvasRenderingContext2D, runs: readonly TileRun[], overdraw: number): void {
  for (const run of runs) ctx.fillRect(run.x0, run.y, run.x1 - run.x0 + overdraw, 1 + overdraw);
}

function drawVoidAndBerth(
  ctx: CanvasRenderingContext2D,
  dock: DockDef,
  shape: DockShape,
  setting: PortSetting,
  px: number,
) {
  if (setting === "station") {
    ctx.fillStyle = pitColor(dock);
    fillRuns(ctx, shape.runs.void, px);
    if (shape.berthStyle === "open") fillRuns(ctx, shape.runs.berth, px);
  }
  if (shape.berthStyle !== "pad") return;
  // A pad set into the quay: a darker apron with a painted frame and centreline.
  const b = shape.berth;
  ctx.fillStyle = mixHex(dock.palette.floor, BLACK, 0.18);
  fillRuns(ctx, shape.runs.berth, px);
  ctx.strokeStyle = rgba(dock.palette.accent, 0.75);
  ctx.lineWidth = 0.14;
  ctx.setLineDash([0.9, 0.5]);
  ctx.strokeRect(b.minX + 0.6, b.minY + 0.6, b.maxX - b.minX - 1.2, b.maxY - b.minY - 1.2);
  ctx.setLineDash([]);
  ctx.strokeStyle = rgba(WHITE, 0.25);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  const midY = (b.minY + b.maxY) / 2;
  ctx.moveTo(b.minX + 1.5, midY);
  ctx.lineTo(b.maxX - 1.5, midY);
  ctx.stroke();
}

/** Floor surface detail, by pattern; strokes batched per pass. */
function drawFloor(
  ctx: CanvasRenderingContext2D,
  dock: DockDef,
  shape: DockShape,
  pattern: FloorPattern,
  px: number,
) {
  const { floor } = dock.palette;
  ctx.fillStyle = floor;
  fillRuns(ctx, shape.runs.floor, px);
  // Wear: a scatter of lighter and darker tiles, the same every frame.
  for (const run of shape.runs.floor) {
    for (let x = run.x0; x < run.x1; x++) {
      const h = hash01(x, run.y, 7);
      if (h > 0.16) continue;
      ctx.fillStyle = h < 0.08 ? rgba(BLACK, 0.06) : rgba(WHITE, 0.035);
      ctx.fillRect(x, run.y, 1, 1);
    }
  }
  const seam = rgba(mixHex(floor, BLACK, 0.6), 0.45);
  ctx.strokeStyle = seam;
  ctx.lineWidth = px;
  ctx.beginPath();
  switch (pattern) {
    case "plates":
      // Deck plates two tiles square, with a rivet line every tile.
      for (const run of shape.runs.floor) {
        if (run.y % 2 === 0) {
          ctx.moveTo(run.x0, run.y);
          ctx.lineTo(run.x1, run.y);
        }
        for (let x = run.x0; x <= run.x1; x++) {
          if (x % 2 !== 0) continue;
          ctx.moveTo(x, run.y);
          ctx.lineTo(x, run.y + 1);
        }
      }
      break;
    case "planks":
      // Pier boards along the pier (x), three to a tile, with staggered butt joints.
      for (const run of shape.runs.floor) {
        for (const s of [0, 1 / 3, 2 / 3]) {
          ctx.moveTo(run.x0, run.y + s);
          ctx.lineTo(run.x1, run.y + s);
        }
        for (let x = run.x0; x < run.x1; x++) {
          for (let row = 0; row < 3; row++) {
            if (hash01(x, run.y, row) > 0.3) continue;
            const jx = x + hash01(run.y, x, row);
            ctx.moveTo(jx, run.y + row / 3);
            ctx.lineTo(jx, run.y + (row + 1) / 3);
          }
        }
      }
      break;
    case "slabs":
      // Poured slabs, three tiles square.
      for (const run of shape.runs.floor) {
        if (run.y % 3 === 0) {
          ctx.moveTo(run.x0, run.y);
          ctx.lineTo(run.x1, run.y);
        }
        for (let x = run.x0; x <= run.x1; x++) {
          if (x % 3 !== 0) continue;
          ctx.moveTo(x, run.y);
          ctx.lineTo(x, run.y + 1);
        }
      }
      break;
  }
  ctx.stroke();
}

function drawWalls(ctx: CanvasRenderingContext2D, dock: DockDef, shape: DockShape, px: number) {
  const { wall, floor } = dock.palette;
  ctx.fillStyle = wall;
  fillRuns(ctx, shape.runs.wall, px);
  // A shadow cast onto the floor, and a lit lip along the wall's edge.
  for (const edge of shape.lips) {
    const depth = 0.3;
    const x0 = Math.min(edge.x1, edge.x1 + edge.nx * depth);
    const y0 = Math.min(edge.y1, edge.y1 + edge.ny * depth);
    const w = edge.nx !== 0 ? depth : edge.x2 - edge.x1;
    const h = edge.ny !== 0 ? depth : edge.y2 - edge.y1;
    const g = ctx.createLinearGradient(
      edge.x1,
      edge.y1,
      edge.x1 + edge.nx * depth,
      edge.y1 + edge.ny * depth,
    );
    g.addColorStop(0, rgba(BLACK, 0.3));
    g.addColorStop(1, rgba(BLACK, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, w, h);
  }
  ctx.strokeStyle = mixHex(wall, floor, 0.55);
  ctx.lineWidth = Math.max(1.5 * px, 0.05);
  ctx.beginPath();
  for (const edge of shape.lips) {
    ctx.moveTo(edge.x1, edge.y1);
    ctx.lineTo(edge.x2, edge.y2);
  }
  ctx.stroke();
}

/** The quay's hazard stripe starts this far from the berth, clear of the hull's rim. */
const QUAY_SETBACK = HULL_RIM + 0.08;

/** Hazard stripes along the quay's edge, on the floor side, just clear of the docked hull. */
function drawQuayEdge(ctx: CanvasRenderingContext2D, dock: DockDef, shape: DockShape, px: number) {
  const band = 0.28;
  for (const edge of shape.quay) {
    const sx = edge.nx * QUAY_SETBACK;
    const sy = edge.ny * QUAY_SETBACK;
    const x0 = Math.min(edge.x1, edge.x1 + edge.nx * band) + sx;
    const y0 = Math.min(edge.y1, edge.y1 + edge.ny * band) + sy;
    const w = edge.nx !== 0 ? band : edge.x2 - edge.x1;
    const h = edge.ny !== 0 ? band : edge.y2 - edge.y1;
    withClipRect(ctx, x0, y0, w, h, () => {
      ctx.fillStyle = rgba(dock.palette.accent, 0.85);
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = rgba(BLACK, 0.75);
      ctx.lineWidth = 0.13;
      ctx.beginPath();
      const length = Math.max(w, h);
      for (let s = -band; s < length + band; s += 0.4) {
        if (edge.ny !== 0) {
          ctx.moveTo(x0 + s, y0 + h);
          ctx.lineTo(x0 + s + band, y0);
        } else {
          ctx.moveTo(x0, y0 + s);
          ctx.lineTo(x0 + w, y0 + s + band);
        }
      }
      ctx.stroke();
    });
  }
  ctx.strokeStyle = rgba(BLACK, 0.5);
  ctx.lineWidth = px;
  ctx.beginPath();
  for (const edge of shape.quay) {
    const k = QUAY_SETBACK + band;
    ctx.moveTo(edge.x1 + edge.nx * k, edge.y1 + edge.ny * k);
    ctx.lineTo(edge.x2 + edge.nx * k, edge.y2 + edge.ny * k);
  }
  ctx.stroke();
}

/** Clamps stand this far in from each end of a quay edge, and back from it, tiles. */
const CLAMP_INSET = 1.5;
const CLAMP_SETBACK = 1.1;
const CLAMP_ARM = 1.2;

/**
 * Station clamps on the quay, one near each end of the ship (clear of the ramps in the middle):
 * arms that lie along the edge when retracted and swing out to grip the hull as `engaged` goes to
 * 1 (dockside §2.4: "clamps" at the end of docking, "clamps release" at the start of undocking).
 * A planet's pad has none.
 */
function drawClamps(
  ctx: CanvasRenderingContext2D,
  dock: DockDef,
  shape: DockShape,
  setting: PortSetting,
  engaged: number,
  px: number,
) {
  if (setting !== "station") return;
  const arm = mixHex(dock.palette.wall, "#9aa6b2", 0.5);
  for (const edge of shape.quay) {
    const length = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
    if (length < CLAMP_INSET * 4) continue;
    const ux = (edge.x2 - edge.x1) / length;
    const uy = (edge.y2 - edge.y1) / length;
    for (const [s, toward] of [
      [CLAMP_INSET, 1],
      [length - CLAMP_INSET, -1],
    ] as const) {
      const bx = edge.x1 + ux * s + edge.nx * CLAMP_SETBACK;
      const by = edge.y1 + uy * s + edge.ny * CLAMP_SETBACK;
      // Retracted: lying along the edge, pointing toward the ship's middle. Engaged: swung round to
      // reach under the hull's rim.
      const angle = (Math.PI / 2) * engaged;
      const dx = toward * ux * Math.cos(angle) - edge.nx * Math.sin(angle);
      const dy = toward * uy * Math.cos(angle) - edge.ny * Math.sin(angle);
      ctx.strokeStyle = arm;
      ctx.lineWidth = 0.22;
      ctx.lineCap = "round";
      segment(ctx, bx, by, bx + dx * CLAMP_ARM, by + dy * CLAMP_ARM);
      ctx.lineCap = "butt";
      ctx.fillStyle = mixHex(dock.palette.wall, BLACK, 0.2);
      ctx.fillRect(bx - 0.22, by - 0.22, 0.44, 0.44);
      ctx.strokeStyle = rgba(dock.palette.accent, 0.8);
      ctx.lineWidth = Math.max(px, 0.04);
      ctx.strokeRect(bx - 0.22, by - 0.22, 0.44, 0.44);
    }
  }
}

/** Freight staging and the delivery bay as floor markings, told apart by line and fill. */
const AREA_LOOK: Readonly<
  Record<DockAreaKind, { readonly dash: readonly number[]; readonly hatch: boolean }>
> = {
  freightStaging: { dash: [0.35, 0.22], hatch: false },
  deliveryBay: { dash: [], hatch: true },
};

function drawAreas(ctx: CanvasRenderingContext2D, dock: DockDef, px: number) {
  for (const area of dock.areas) {
    const look = AREA_LOOK[area.kind];
    const r = area.rect;
    const x0 = r.x + 0.1;
    const y0 = r.y + 0.1;
    const w = r.w - 0.2;
    const h = r.h - 0.2;
    const line = area.kind === "freightStaging" ? dock.palette.accent : "#e7edf3";
    ctx.fillStyle = rgba(line, area.kind === "freightStaging" ? 0.1 : 0.06);
    ctx.fillRect(x0, y0, w, h);
    if (look.hatch) {
      withClipRect(ctx, x0, y0, w, h, () => {
        ctx.strokeStyle = rgba(line, 0.16);
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        for (let s = -h; s < w; s += 0.5) {
          ctx.moveTo(x0 + s, y0 + h);
          ctx.lineTo(x0 + s + h, y0);
        }
        ctx.stroke();
      });
    }
    // A dark under-stroke keeps the paint legible on a pale pad or pier.
    ctx.strokeStyle = rgba(BLACK, 0.35);
    ctx.lineWidth = Math.max(3 * px, 0.14);
    ctx.strokeRect(x0, y0, w, h);
    ctx.strokeStyle = rgba(line, 0.85);
    ctx.lineWidth = Math.max(1.5 * px, 0.07);
    ctx.setLineDash(look.dash as number[]);
    ctx.strokeRect(x0, y0, w, h);
    ctx.setLineDash([]);
    // Corner brackets, so the area reads even under a stack of crates.
    ctx.lineWidth = Math.max(2 * px, 0.11);
    ctx.strokeStyle = rgba(line, 0.9);
    ctx.beginPath();
    const c = 0.4;
    for (const [cx, cy, sx, sy] of [
      [x0, y0, 1, 1],
      [x0 + w, y0, -1, 1],
      [x0, y0 + h, 1, -1],
      [x0 + w, y0 + h, -1, -1],
    ] as const) {
      ctx.moveTo(cx + sx * c, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * c);
    }
    ctx.stroke();
  }
}

/** Canvas rotation that turns a post's local "front" (−y) toward its facing. */
const FACING_ANGLE: Readonly<Record<EdgeSide, number>> = {
  n: 0,
  e: Math.PI / 2,
  s: Math.PI,
  w: -Math.PI / 2,
};

type PostDrawer = (ctx: CanvasRenderingContext2D, dock: DockDef, px: number) => void;

/**
 * A post's drawing in its local frame (tile centre at the origin, facing −y, its back edge at
 * y = 0.5): `floor` is drawn with the map (layer 4); `wall`, the door in the wall behind a gate or
 * warehouse door, after the foreground (layer 7), since the wall it is set in may be under a
 * bay wall or the terminal's edge.
 */
interface PostArt {
  readonly floor: PostDrawer;
  readonly wall?: PostDrawer;
}

/** Light from an open doorway spilling onto the floor in front of it. */
function spill(ctx: CanvasRenderingContext2D, dock: DockDef, glow: number) {
  const g = ctx.createRadialGradient(0, 0.5, 0, 0, 0.5, 1.6);
  g.addColorStop(0, rgba(dock.palette.accent, glow));
  g.addColorStop(1, rgba(dock.palette.accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-1.6, -1.1, 3.2, 1.6);
}

/**
 * Doors at the edge of the simulated world (dockside §3.5): a dark opening behind the post, framed
 * in the accent with a light either side. `half` is half the opening's width.
 */
function doorway(ctx: CanvasRenderingContext2D, dock: DockDef, px: number, half: number) {
  ctx.fillStyle = "#07090c";
  ctx.fillRect(-half, 0.45, half * 2, 0.45);
  ctx.strokeStyle = rgba(dock.palette.accent, 0.95);
  ctx.lineWidth = Math.max(1.5 * px, 0.08);
  ctx.beginPath();
  ctx.moveTo(-half, 0.9);
  ctx.lineTo(-half, 0.45);
  ctx.lineTo(half, 0.45);
  ctx.lineTo(half, 0.9);
  ctx.stroke();
  ctx.fillStyle = mixHex(dock.palette.accent, WHITE, 0.4);
  for (const side of [-1, 1]) {
    disc(ctx, side * (half + 0.18), 0.55, 0.07);
  }
}

/** A wide roller door, slatted. */
function rollerDoor(ctx: CanvasRenderingContext2D, dock: DockDef, px: number) {
  const half = 1.05;
  ctx.fillStyle = mixHex(dock.palette.wall, dock.palette.accent, 0.25);
  ctx.fillRect(-half, 0.45, half * 2, 0.45);
  ctx.strokeStyle = rgba(BLACK, 0.5);
  ctx.lineWidth = Math.max(px, 0.03);
  ctx.beginPath();
  for (let y = 0.55; y < 0.9; y += 0.1) {
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
  }
  ctx.stroke();
  ctx.strokeStyle = rgba(dock.palette.accent, 0.9);
  ctx.lineWidth = Math.max(1.5 * px, 0.06);
  ctx.strokeRect(-half, 0.45, half * 2, 0.45);
}

const POST_ART: Readonly<Record<DockPostKind, PostArt>> = {
  gate: {
    floor: (ctx, dock) => spill(ctx, dock, 0.3),
    wall: (ctx, dock, px) => doorway(ctx, dock, px, 0.75),
  },
  loungeDoor: {
    floor: (ctx, dock) => spill(ctx, dock, 0.4),
    wall: (ctx, dock, px) => doorway(ctx, dock, px, 0.5),
  },
  warehouseDoor: {
    // A hazard-striped sill on the floor in front of the door.
    floor: (ctx, dock) => {
      const half = 1.05;
      ctx.fillStyle = rgba(dock.palette.accent, 0.9);
      ctx.fillRect(-half, 0.32, half * 2, 0.12);
      ctx.fillStyle = rgba(BLACK, 0.8);
      for (let x = -half; x < half; x += 0.24) ctx.fillRect(x, 0.32, 0.1, 0.12);
    },
    wall: rollerDoor,
  },
  kiosk: {
    // A small booth with a lit screen facing out.
    floor: (ctx, dock, px) => {
      ctx.fillStyle = rgba(BLACK, 0.3);
      ctx.fillRect(-0.3, 0.12, 0.7, 0.4);
      ctx.fillStyle = mixHex(dock.palette.wall, dock.palette.floor, 0.3);
      ctx.fillRect(-0.36, 0.04, 0.72, 0.42);
      ctx.strokeStyle = rgba(BLACK, 0.6);
      ctx.lineWidth = Math.max(px, 0.03);
      ctx.strokeRect(-0.36, 0.04, 0.72, 0.42);
      const glow = ctx.createRadialGradient(0, 0.05, 0, 0, 0.05, 0.8);
      glow.addColorStop(0, rgba(dock.palette.accent, 0.35));
      glow.addColorStop(1, rgba(dock.palette.accent, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(-0.8, -0.75, 1.6, 0.85);
      ctx.fillStyle = mixHex(dock.palette.accent, WHITE, 0.25);
      ctx.fillRect(-0.26, 0.04, 0.52, 0.1);
    },
  },
  marketStall: {
    // A counter under a striped awning, a few goods on it.
    floor: (ctx, dock, px) => {
      const half = 0.8;
      withClipRect(ctx, -half, 0.18, half * 2, 0.62, () => {
        for (let i = 0, x = -half; x < half; x += 0.2, i++) {
          ctx.fillStyle = i % 2 === 0 ? dock.palette.accent : "#efe6cf";
          ctx.fillRect(x, 0.18, 0.2, 0.62);
        }
      });
      ctx.fillStyle = mixHex(dock.palette.wall, "#7a5a3a", 0.5);
      ctx.fillRect(-0.62, 0.02, 1.24, 0.24);
      ctx.strokeStyle = rgba(BLACK, 0.6);
      ctx.lineWidth = Math.max(px, 0.03);
      ctx.strokeRect(-0.62, 0.02, 1.24, 0.24);
      for (const [x, color] of [
        [-0.38, "#d9734a"],
        [-0.08, "#e8cf6a"],
        [0.24, "#7fb069"],
      ] as const) {
        ctx.fillStyle = color;
        disc(ctx, x, 0.14, 0.07);
      }
    },
  },
  bench: {
    floor: (ctx, dock, px) => {
      ctx.fillStyle = rgba(BLACK, 0.3);
      ctx.fillRect(-0.5, 0.26, 1.1, 0.26);
      ctx.fillStyle = mixHex(dock.palette.wall, dock.palette.floor, 0.55);
      ctx.fillRect(-0.56, 0.18, 1.12, 0.26);
      ctx.strokeStyle = rgba(BLACK, 0.45);
      ctx.lineWidth = Math.max(px, 0.025);
      ctx.beginPath();
      ctx.moveTo(-0.56, 0.27);
      ctx.lineTo(0.56, 0.27);
      ctx.moveTo(-0.56, 0.36);
      ctx.lineTo(0.56, 0.36);
      ctx.stroke();
      ctx.strokeRect(-0.56, 0.18, 1.12, 0.26);
    },
  },
};

function inPostFrame(ctx: CanvasRenderingContext2D, post: DockPostDef, draw: () => void): void {
  ctx.save();
  ctx.translate(post.tile.x + 0.5, post.tile.y + 0.5);
  ctx.rotate(FACING_ANGLE[post.facing]);
  draw();
  ctx.restore();
}

function drawPostFloor(
  ctx: CanvasRenderingContext2D,
  dock: DockDef,
  post: DockPostDef,
  px: number,
  selected: boolean,
) {
  inPostFrame(ctx, post, () => POST_ART[post.kind].floor(ctx, dock, px));
  if (selected) {
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 2 * px;
    ctx.strokeRect(post.tile.x - 0.1, post.tile.y - 0.1, 1.2, 1.2);
  }
}

/** Layer 4: the dock map, behind the hull. */
export function drawDock(ctx: CanvasRenderingContext2D, dock: DockDef, paint: DockPaint): void {
  if (paint.alpha <= 0) return;
  const shape = dockShape(dock);
  const { px } = paint;
  ctx.save();
  if (paint.setting === "station" && paint.enclosure > 0) {
    // Inside the bay: its darkness closes in around the whole view as the camera settles, so
    // the station's outer structure and open space don't show past the map's edges.
    ctx.globalAlpha = paint.alpha * paint.enclosure;
    ctx.fillStyle = pitColor(dock);
    const v = paint.view;
    ctx.fillRect(v.minX, v.minY, v.maxX - v.minX, v.maxY - v.minY);
  }
  ctx.globalAlpha = paint.alpha;
  ctx.translate(paint.origin.x, paint.origin.y);
  drawVoidAndBerth(ctx, dock, shape, paint.setting, px);
  drawFloor(ctx, dock, shape, dockSurface(shape, paint.setting).floorPattern, px);
  drawWalls(ctx, dock, shape, px);
  drawAreas(ctx, dock, px);
  drawQuayEdge(ctx, dock, shape, px);
  drawClamps(ctx, dock, shape, paint.setting, paint.clamps, px);
  for (const post of dock.posts) {
    drawPostFloor(ctx, dock, post, px, post.key === paint.selectedPostKey);
  }
  const look: PropLook = { palette: dock.palette, setting: paint.setting, px };
  for (const prop of dock.props) drawProp(ctx, prop, look);
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Foreground (layer 7)
// ---------------------------------------------------------------------------------------------

/** Opacity of each foreground kind away from the ship, and where it crosses the ship. */
const FOREGROUND_ALPHA: Readonly<
  Record<DockForegroundKind, { readonly clear: number; readonly overShip: number }>
> = {
  bayWall: { clear: 0.96, overShip: 0.3 },
  gantry: { clear: 0.92, overShip: 0.22 },
  terminalEdge: { clear: 0.96, overShip: 0.3 },
  awning: { clear: 0.62, overShip: 0.25 },
  rockWall: { clear: 0.97, overShip: 0.3 },
};

type ForegroundDrawer = (
  ctx: CanvasRenderingContext2D,
  dock: DockDef,
  piece: DockForegroundDef,
  inward: { readonly x: number; readonly y: number },
  px: number,
) => void;

/** Unit vector from a foreground rect toward the map's middle, along the rect's short axis. */
function inwardOf(dock: DockDef, r: DockRect): { x: number; y: number } {
  if (r.w >= r.h) return { x: 0, y: r.y + r.h / 2 < dock.height / 2 ? 1 : -1 };
  return { x: r.x + r.w / 2 < dock.width / 2 ? 1 : -1, y: 0 };
}

/** A line along the edge of `r` that faces `inward`. */
function innerEdge(r: DockRect, inward: { x: number; y: number }) {
  if (inward.y > 0) return { x1: r.x, y1: r.y + r.h, x2: r.x + r.w, y2: r.y + r.h };
  if (inward.y < 0) return { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y };
  if (inward.x > 0) return { x1: r.x + r.w, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
  return { x1: r.x, y1: r.y, x2: r.x, y2: r.y + r.h };
}

const drawBayWall: ForegroundDrawer = (ctx, dock, piece, inward, px) => {
  const r = piece.rect;
  ctx.fillStyle = mixHex(dock.palette.wall, "#3a4452", 0.25);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const along = r.w >= r.h;
  ctx.strokeStyle = rgba(BLACK, 0.45);
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  for (let s = 1.5; s < (along ? r.w : r.h); s += 3) {
    if (along) {
      ctx.moveTo(r.x + s, r.y);
      ctx.lineTo(r.x + s, r.y + r.h);
    } else {
      ctx.moveTo(r.x, r.y + s);
      ctx.lineTo(r.x + r.w, r.y + s);
    }
  }
  ctx.stroke();
  const e = innerEdge(r, inward);
  ctx.fillStyle = mixHex(dock.palette.accent, WHITE, 0.3);
  for (let s = 3; s < (along ? r.w : r.h); s += 6) {
    const x = along ? r.x + s : e.x1 - inward.x * 0.3;
    const y = along ? e.y1 - inward.y * 0.3 : r.y + s;
    ctx.fillRect(x - 0.18, y - 0.08, 0.36, 0.16);
  }
  ctx.strokeStyle = rgba(dock.palette.accent, 0.85);
  ctx.lineWidth = Math.max(1.5 * px, 0.08);
  segment(ctx, e.x1, e.y1, e.x2, e.y2);
};

const drawGantry: ForegroundDrawer = (ctx, dock, piece, _inward, px) => {
  const r = piece.rect;
  const steel = mixHex("#8a9bb0", dock.palette.wall, 0.3);
  const vertical = r.h > r.w;
  const length = vertical ? r.h : r.w;
  const thick = vertical ? r.w : r.h;
  const at = (s: number, c: number) =>
    vertical ? ([r.x + c * thick, r.y + s] as const) : ([r.x + s, r.y + c * thick] as const);
  ctx.strokeStyle = steel;
  ctx.lineWidth = 0.14;
  ctx.beginPath();
  for (const c of [0.12, 0.88]) {
    const [x0, y0] = at(0, c);
    const [x1, y1] = at(length, c);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
  ctx.stroke();
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  for (let s = 0, i = 0; s <= length; s += thick * 0.9, i++) {
    const [x, y] = at(s, i % 2 === 0 ? 0.12 : 0.88);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#e0453a";
  for (const s of [0.4, length - 0.4]) {
    const [x, y] = at(s, 0.5);
    disc(ctx, x, y, Math.max(0.09, 2 * px));
  }
};

const drawTerminalEdge: ForegroundDrawer = (ctx, dock, piece, inward, px) => {
  const r = piece.rect;
  ctx.fillStyle = mixHex(dock.palette.wall, BLACK, 0.15);
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // Lit windows into the terminal beyond, some dark.
  const along = r.w >= r.h;
  const length = along ? r.w : r.h;
  for (let s = 0.4, i = 0; s < length - 1; s += 2.2, i++) {
    const lit = hash01(i, Math.round(r.x), Math.round(r.y)) > 0.25;
    ctx.fillStyle = lit ? rgba(dock.palette.accent, 0.55) : rgba(WHITE, 0.06);
    if (along) ctx.fillRect(r.x + s, r.y + r.h * 0.25, 1.6, r.h * 0.5);
    else ctx.fillRect(r.x + r.w * 0.25, r.y + s, r.w * 0.5, 1.6);
  }
  const e = innerEdge(r, inward);
  ctx.strokeStyle = mixHex(dock.palette.wall, WHITE, 0.35);
  ctx.lineWidth = Math.max(1.5 * px, 0.07);
  segment(ctx, e.x1, e.y1, e.x2, e.y2);
};

const drawAwning: ForegroundDrawer = (ctx, dock, piece, inward, px) => {
  const r = piece.rect;
  const along = r.w >= r.h;
  const stripe = 0.5;
  withClipRect(ctx, r.x, r.y, r.w, r.h, () => {
    for (let s = 0, i = 0; s < (along ? r.w : r.h); s += stripe, i++) {
      ctx.fillStyle = i % 2 === 0 ? dock.palette.accent : "#efe6cf";
      if (along) ctx.fillRect(r.x + s, r.y, stripe, r.h);
      else ctx.fillRect(r.x, r.y + s, r.w, stripe);
    }
  });
  // Scalloped front edge.
  const e = innerEdge(r, inward);
  ctx.fillStyle = dock.palette.accent;
  const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  for (let s = stripe / 2; s < len; s += stripe) {
    const x = e.x1 + ((e.x2 - e.x1) / len) * s;
    const y = e.y1 + ((e.y2 - e.y1) / len) * s;
    disc(ctx, x, y, stripe / 2);
  }
  ctx.strokeStyle = rgba(BLACK, 0.35);
  ctx.lineWidth = px;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
};

const drawRockWall: ForegroundDrawer = (ctx, dock, piece, _inward, px) => {
  const r = piece.rect;
  const rock = mixHex(dock.palette.wall, "#3b352f", 0.3);
  ctx.fillStyle = rock;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // Faceted stones and cracks, low in contrast, so it reads as raw rock rather than a bulkhead.
  const seed = Math.round(r.x * 31 + r.y * 17 + r.w * 7 + r.h);
  const count = Math.round(r.w * r.h * 1.2) + 3;
  for (let i = 0; i < count; i++) {
    const cx = r.x + hash01(seed, i, 1) * r.w;
    const cy = r.y + hash01(seed, i, 2) * r.h;
    const radius = Math.min(
      0.2 + hash01(seed, i, 3) * 0.4,
      Math.max(0.25, Math.min(r.w, r.h) * 0.5),
    );
    const shade = hash01(seed, i, 4);
    ctx.fillStyle = mixHex(rock, shade < 0.6 ? BLACK : "#8a7f70", 0.06 + shade * 0.1);
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + shade;
      const rr = radius * (0.7 + hash01(seed, i, k + 5) * 0.3);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr * 0.8;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = rgba(BLACK, 0.35);
  ctx.lineWidth = Math.max(px, 0.03);
  ctx.beginPath();
  const cracks = Math.max(2, Math.round((r.w + r.h) / 4));
  for (let i = 0; i < cracks; i++) {
    let x = r.x + hash01(seed, i, 20) * r.w;
    let y = r.y + hash01(seed, i, 21) * r.h;
    ctx.moveTo(x, y);
    for (let k = 0; k < 3; k++) {
      x += (hash01(seed, i, k + 22) - 0.5) * 1.2;
      y += (hash01(seed, i, k + 26) - 0.5) * 1.2;
      ctx.lineTo(Math.min(r.x + r.w, Math.max(r.x, x)), Math.min(r.y + r.h, Math.max(r.y, y)));
    }
  }
  ctx.stroke();
};

const FOREGROUND_DRAWERS: Readonly<Record<DockForegroundKind, ForegroundDrawer>> = {
  bayWall: drawBayWall,
  gantry: drawGantry,
  terminalEdge: drawTerminalEdge,
  awning: drawAwning,
  rockWall: drawRockWall,
};

/**
 * Structure (walls, the terminal's edge, rock) stands only where the map has no floor: a gap the
 * map leaves in it (a gate set in the terminal's wall) stays open. Gantries and awnings are
 * overhead, so they cover floor too.
 */
const STRUCTURAL: Readonly<Record<DockForegroundKind, boolean>> = {
  bayWall: true,
  gantry: false,
  terminalEdge: true,
  awning: false,
  rockWall: true,
};

/** Clip to `r` minus its floor tiles (dock frame). */
function clipToStructure(ctx: CanvasRenderingContext2D, shape: DockShape, r: DockRect): void {
  ctx.beginPath();
  for (const kind of ["wall", "void", "berth"] as const) {
    for (const run of shape.runs[kind]) {
      if (run.y < r.y || run.y >= r.y + r.h) continue;
      const x0 = Math.max(run.x0, r.x);
      const x1 = Math.min(run.x1, r.x + r.w);
      if (x1 > x0) ctx.rect(x0, run.y, x1 - x0, 1);
    }
  }
  // Anything of the rect beyond the map is structure too.
  ctx.clip();
}

/**
 * Layer 7: the dock's foreground over the deck, then the doors set in its walls. Each piece is
 * drawn twice through complementary clips: opaque-ish away from the ship, faint over it (`ship`,
 * deck coordinates, is never covered by more than `overShip`). The people and their labels are
 * drawn after this, in screen space.
 */
export function drawDockForeground(
  ctx: CanvasRenderingContext2D,
  dock: DockDef,
  paint: Pick<DockPaint, "origin" | "alpha" | "px">,
  ship: Bounds,
  view: Bounds,
): void {
  if (paint.alpha <= 0) return;
  const shape = dockShape(dock);
  for (const overShip of [false, true]) {
    ctx.save();
    ctx.beginPath();
    // Away from the ship: the view with the ship's rect cut out of it.
    if (!overShip) ctx.rect(view.minX, view.minY, view.maxX - view.minX, view.maxY - view.minY);
    ctx.rect(ship.minX, ship.minY, ship.maxX - ship.minX, ship.maxY - ship.minY);
    ctx.clip(overShip ? "nonzero" : "evenodd");
    ctx.translate(paint.origin.x, paint.origin.y);
    for (const piece of dock.foreground) {
      const alpha = FOREGROUND_ALPHA[piece.kind];
      ctx.save();
      if (STRUCTURAL[piece.kind]) clipToStructure(ctx, shape, piece.rect);
      ctx.globalAlpha = paint.alpha * (overShip ? alpha.overShip : alpha.clear);
      FOREGROUND_DRAWERS[piece.kind](ctx, dock, piece, inwardOf(dock, piece.rect), paint.px);
      ctx.restore();
    }
    if (!overShip) {
      ctx.globalAlpha = paint.alpha;
      for (const post of dock.posts) {
        const wall = POST_ART[post.kind].wall;
        if (wall !== undefined) inPostFrame(ctx, post, () => wall(ctx, dock, paint.px));
      }
    }
    ctx.restore();
  }
}
