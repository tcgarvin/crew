/**
 * Dockside §3.1 (phase 2): one procedural drawing per prop kind in the closed vocabulary
 * (`DOCK_PROP_KINDS`), in the dock map's tile frame. Props are set dressing, so they are drawn
 * muted, full-tile and textured, never as the small bright outlined squares that freight items
 * are; a crate prop must not read as cargo. `rot` orients the drawing: 0 or 180 runs the prop's
 * length along x, 90 or 270 along y.
 */
import type { DockPaletteDef, DockPropDef, DockPropKind, DockRect, PortSetting } from "@crew/sim";
import { BLACK, WHITE, hash01, hashKey, mixHex, rgba } from "./color";

export interface PropLook {
  readonly palette: DockPaletteDef;
  readonly setting: PortSetting;
  /** One CSS pixel in tile units. */
  readonly px: number;
}

type PropDrawer = (ctx: CanvasRenderingContext2D, prop: DockPropDef, look: PropLook) => void;

/** Does the prop's length run along x? */
function alongX(prop: Pick<DockPropDef, "rot">): boolean {
  return prop.rot === 0 || prop.rot === 180;
}

function shadow(ctx: CanvasRenderingContext2D, r: DockRect, inset: number): void {
  ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
  ctx.fillRect(r.x + inset + 0.08, r.y + inset + 0.12, r.w - inset * 2, r.h - inset * 2);
}

function hairline(look: PropLook, min = 0.04): number {
  return Math.max(look.px, min);
}

/** Muted stand-ins for other people's paint, mixed toward the dock's own wall colour. */
const CARGO_PAINT = ["#8a5a3a", "#3f6b6b", "#4a5f86", "#76703f", "#6e4a63", "#5d6a74"] as const;

function paint(look: PropLook, seed: number): string {
  const base = CARGO_PAINT[Math.floor(hash01(seed) * CARGO_PAINT.length)] ?? CARGO_PAINT[0];
  return mixHex(base, look.palette.wall, 0.3);
}

const drawCrates: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  shadow(ctx, r, 0.05);
  const seed = hashKey(prop.key);
  const slatsAlongX = alongX(prop);
  ctx.lineWidth = hairline(look);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = 0.06 + hash01(seed, x, y) * 0.05;
      const fill = paint(look, seed + (hash01(seed, y, x) < 0.6 ? 0 : x * 7 + y));
      ctx.fillStyle = fill;
      ctx.fillRect(x + i, y + i, 1 - i * 2, 1 - i * 2);
      // Slats, and a cross-brace on some, so a stack reads as crates rather than a block.
      ctx.strokeStyle = rgba(mixHex(fill, BLACK, 0.55), 0.8);
      ctx.strokeRect(x + i, y + i, 1 - i * 2, 1 - i * 2);
      ctx.beginPath();
      for (const s of [0.36, 0.64]) {
        if (slatsAlongX) {
          ctx.moveTo(x + i, y + s);
          ctx.lineTo(x + 1 - i, y + s);
        } else {
          ctx.moveTo(x + s, y + i);
          ctx.lineTo(x + s, y + 1 - i);
        }
      }
      if (hash01(seed, x + 3, y + 5) < 0.4) {
        ctx.moveTo(x + i, y + i);
        ctx.lineTo(x + 1 - i, y + 1 - i);
      }
      ctx.stroke();
      ctx.fillStyle = rgba(WHITE, 0.08);
      ctx.fillRect(x + i, y + i, 1 - i * 2, 0.08);
    }
  }
};

const drawContainer: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const inset = 0.06;
  shadow(ctx, r, inset);
  const x0 = r.x + inset;
  const y0 = r.y + inset;
  const w = r.w - inset * 2;
  const h = r.h - inset * 2;
  const fill = paint(look, hashKey(prop.key) + 11);
  ctx.fillStyle = fill;
  ctx.fillRect(x0, y0, w, h);
  // Corrugations across the length, doors and locking bars at one end.
  ctx.strokeStyle = rgba(mixHex(fill, BLACK, 0.6), 0.55);
  ctx.lineWidth = hairline(look, 0.03);
  ctx.beginPath();
  const lengthX = alongX(prop);
  const length = lengthX ? w : h;
  for (let s = 0.2; s < length - 0.35; s += 0.2) {
    if (lengthX) {
      ctx.moveTo(x0 + s, y0 + 0.08);
      ctx.lineTo(x0 + s, y0 + h - 0.08);
    } else {
      ctx.moveTo(x0 + 0.08, y0 + s);
      ctx.lineTo(x0 + w - 0.08, y0 + s);
    }
  }
  ctx.stroke();
  ctx.strokeStyle = rgba(mixHex(fill, WHITE, 0.4), 0.7);
  ctx.lineWidth = hairline(look, 0.05);
  ctx.beginPath();
  if (lengthX) {
    const ex = prop.rot === 0 ? x0 + w - 0.22 : x0 + 0.22;
    ctx.moveTo(ex, y0 + 0.06);
    ctx.lineTo(ex, y0 + h - 0.06);
  } else {
    const ey = prop.rot === 90 ? y0 + h - 0.22 : y0 + 0.22;
    ctx.moveTo(x0 + 0.06, ey);
    ctx.lineTo(x0 + w - 0.06, ey);
  }
  ctx.stroke();
  ctx.strokeStyle = rgba(mixHex(fill, BLACK, 0.7), 0.9);
  ctx.lineWidth = hairline(look);
  ctx.strokeRect(x0, y0, w, h);
};

const drawCrane: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const steel = mixHex(look.palette.wall, "#9aa6b2", 0.45);
  shadow(ctx, r, 0.1);
  ctx.fillStyle = mixHex(look.palette.wall, BLACK, 0.2);
  ctx.fillRect(r.x + 0.1, r.y + 0.1, r.w - 0.2, r.h - 0.2);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const turret = Math.min(r.w, r.h) * 0.3;
  // The jib swings out over the quay at a fixed angle (fore and toward the berth), with a
  // counterweight behind the turret and the hook hanging at its tip.
  const angle = -Math.PI * (0.62 + (prop.rot / 360) * 0.5);
  const reach = Math.max(r.w, r.h) * 1.6;
  const tipX = cx + Math.cos(angle) * reach;
  const tipY = cy + Math.sin(angle) * reach;
  const tailX = cx - Math.cos(angle) * turret * 1.8;
  const tailY = cy - Math.sin(angle) * turret * 1.8;
  ctx.lineCap = "round";
  ctx.strokeStyle = rgba(BLACK, 0.3);
  ctx.lineWidth = 0.32;
  ctx.beginPath();
  ctx.moveTo(tailX + 0.12, tailY + 0.18);
  ctx.lineTo(tipX + 0.12, tipY + 0.18);
  ctx.stroke();
  ctx.strokeStyle = mixHex(look.palette.accent, steel, 0.35);
  ctx.lineWidth = 0.26;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  // Truss lacing along the jib.
  ctx.strokeStyle = rgba(BLACK, 0.45);
  ctx.lineWidth = hairline(look, 0.03);
  ctx.beginPath();
  const nx = -Math.sin(angle) * 0.1;
  const ny = Math.cos(angle) * 0.1;
  for (let s = 0, i = 0; s < reach; s += 0.25, i++) {
    const x = cx + Math.cos(angle) * s;
    const y = cy + Math.sin(angle) * s;
    const side = i % 2 === 0 ? 1 : -1;
    if (s === 0) ctx.moveTo(x + nx * side, y + ny * side);
    else ctx.lineTo(x + nx * side, y + ny * side);
  }
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.fillStyle = mixHex(look.palette.wall, BLACK, 0.35);
  ctx.fillRect(tailX - 0.22, tailY - 0.22, 0.44, 0.44);
  ctx.fillStyle = steel;
  ctx.beginPath();
  ctx.arc(cx, cy, turret, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = rgba(BLACK, 0.6);
  ctx.lineWidth = hairline(look);
  ctx.stroke();
  ctx.fillStyle = look.palette.accent;
  ctx.beginPath();
  ctx.arc(tipX, tipY, 0.11, 0, Math.PI * 2);
  ctx.fill();
};

const drawHullSection: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const lengthX = alongX(prop);
  const plate = mixHex("#6b737c", look.palette.wall, 0.25);
  shadow(ctx, r, 0.08);
  // A half-cut section of somebody's hull: a curved plate (lit along its crown), ribbed across
  // its length, with one torch-cut edge still glowing.
  const x0 = r.x + 0.08;
  const y0 = r.y + 0.08;
  const w = r.w - 0.16;
  const h = r.h - 0.16;
  const gradient = lengthX
    ? ctx.createLinearGradient(0, y0, 0, y0 + h)
    : ctx.createLinearGradient(x0, 0, x0 + w, 0);
  gradient.addColorStop(0, mixHex(plate, BLACK, 0.35));
  gradient.addColorStop(0.45, mixHex(plate, WHITE, 0.2));
  gradient.addColorStop(1, mixHex(plate, BLACK, 0.5));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  if (lengthX) {
    ctx.moveTo(x0, y0 + h * 0.15);
    ctx.quadraticCurveTo(x0 + w / 2, y0 - h * 0.1, x0 + w, y0 + h * 0.15);
    ctx.lineTo(x0 + w, y0 + h);
    ctx.lineTo(x0, y0 + h);
  } else {
    ctx.moveTo(x0 + w * 0.15, y0);
    ctx.quadraticCurveTo(x0 - w * 0.1, y0 + h / 2, x0 + w * 0.15, y0 + h);
    ctx.lineTo(x0 + w, y0 + h);
    ctx.lineTo(x0 + w, y0);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(BLACK, 0.45);
  ctx.lineWidth = hairline(look, 0.04);
  ctx.stroke();
  ctx.beginPath();
  const length = lengthX ? w : h;
  for (let s = 0.45; s < length - 0.2; s += 0.6) {
    if (lengthX) {
      ctx.moveTo(x0 + s, y0 + h * 0.12);
      ctx.lineTo(x0 + s, y0 + h);
    } else {
      ctx.moveTo(x0 + w * 0.12, y0 + s);
      ctx.lineTo(x0 + w, y0 + s);
    }
  }
  ctx.stroke();
  // The cut edge: ragged, with hot spots in the dock's accent.
  const seed = hashKey(prop.key);
  ctx.strokeStyle = rgba(look.palette.accent, 0.9);
  ctx.lineWidth = Math.max(1.5 * look.px, 0.07);
  ctx.beginPath();
  const steps = Math.max(4, Math.round(length * 3));
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * length;
    const jag = (hash01(seed, i) - 0.5) * 0.18;
    const x = lengthX ? x0 + s : x0 + w + jag - 0.05;
    const y = lengthX ? y0 + h + jag - 0.05 : y0 + s;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = rgba(look.palette.accent, 0.35);
  for (let i = 0; i < 3; i++) {
    const s = (0.2 + 0.3 * i + hash01(seed, i, 9) * 0.1) * length;
    const x = lengthX ? x0 + s : x0 + w;
    const y = lengthX ? y0 + h : y0 + s;
    ctx.beginPath();
    ctx.arc(x, y, 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
};

const LEAF = ["#4f7d3a", "#6a9a45", "#88b25a", "#3f6a35"] as const;

const drawPlanter: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  shadow(ctx, r, 0.06);
  ctx.fillStyle = mixHex(look.palette.wall, "#6b5a48", 0.4);
  ctx.fillRect(r.x + 0.06, r.y + 0.06, r.w - 0.12, r.h - 0.12);
  ctx.fillStyle = "#3a2a1c";
  ctx.fillRect(r.x + 0.16, r.y + 0.16, r.w - 0.32, r.h - 0.32);
  const seed = hashKey(prop.key);
  const count = Math.round(r.w * r.h * 5);
  for (let i = 0; i < count; i++) {
    const x = r.x + 0.2 + hash01(seed, i, 1) * (r.w - 0.4);
    const y = r.y + 0.2 + hash01(seed, i, 2) * (r.h - 0.4);
    const radius = 0.13 + hash01(seed, i, 3) * 0.14;
    ctx.fillStyle = LEAF[i % LEAF.length] ?? LEAF[0];
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
};

const drawConveyor: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const lengthX = alongX(prop);
  shadow(ctx, r, 0.05);
  // Frame, belt, rollers across it, and ore riding the belt.
  ctx.fillStyle = mixHex(look.palette.wall, "#7a7f86", 0.35);
  ctx.fillRect(r.x + 0.04, r.y + 0.04, r.w - 0.08, r.h - 0.08);
  const belt = lengthX
    ? { x: r.x + 0.04, y: r.y + 0.2, w: r.w - 0.08, h: r.h - 0.4 }
    : { x: r.x + 0.2, y: r.y + 0.04, w: r.w - 0.4, h: r.h - 0.08 };
  ctx.fillStyle = "#1f1d1b";
  ctx.fillRect(belt.x, belt.y, belt.w, belt.h);
  ctx.strokeStyle = rgba(WHITE, 0.12);
  ctx.lineWidth = hairline(look, 0.03);
  ctx.beginPath();
  const length = lengthX ? belt.w : belt.h;
  for (let s = 0.17; s < length; s += 0.34) {
    if (lengthX) {
      ctx.moveTo(belt.x + s, belt.y);
      ctx.lineTo(belt.x + s, belt.y + belt.h);
    } else {
      ctx.moveTo(belt.x, belt.y + s);
      ctx.lineTo(belt.x + belt.w, belt.y + s);
    }
  }
  ctx.stroke();
  // Ore as small angular chunks in dull rock colours (D69): round gold lumps read as crew dots
  // at phone scale, so no discs and nothing near the accent's gold.
  const seed = hashKey(prop.key);
  const ores = ["#6d5b4a", "#5a5550", "#7a6a58"].map((c) => mixHex(c, look.palette.wall, 0.25));
  for (let s = 0.3; s < length - 0.2; s += 0.42) {
    const jitter = hash01(seed, Math.round(s * 10));
    const along = s + jitter * 0.15;
    const across = (hash01(seed, Math.round(s * 10), 1) - 0.5) * 0.2;
    const x = lengthX ? belt.x + along : belt.x + belt.w / 2 + across;
    const y = lengthX ? belt.y + belt.h / 2 + across : belt.y + along;
    const size = 0.07 + jitter * 0.04;
    const turn = hash01(seed, Math.round(s * 10), 2) * Math.PI;
    ctx.fillStyle = ores[Math.floor(jitter * ores.length)] ?? ores[0] ?? "#6d5b4a";
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const angle = turn + (k * Math.PI) / 2 + (hash01(seed, k, Math.round(s * 10)) - 0.5) * 0.6;
      const reach = size * (k % 2 === 0 ? 1.3 : 0.8);
      const px = x + Math.cos(angle) * reach;
      const py = y + Math.sin(angle) * reach;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = rgba(look.palette.accent, 0.5);
  ctx.lineWidth = hairline(look, 0.04);
  ctx.strokeRect(r.x + 0.04, r.y + 0.04, r.w - 0.08, r.h - 0.08);
};

const drawBollard: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const radius = Math.min(r.w, r.h) * 0.3;
  const body = look.setting === "planet" ? mixHex("#6b4f35", look.palette.wall, 0.3) : "#3b4048";
  ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
  ctx.beginPath();
  ctx.arc(cx + 0.07, cy + 0.1, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = look.palette.accent;
  ctx.lineWidth = Math.max(1.5 * look.px, 0.06);
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.62, 0, Math.PI * 2);
  ctx.stroke();
};

const drawLamp: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1.5);
  glow.addColorStop(0, rgba(look.palette.accent, 0.38));
  glow.addColorStop(1, rgba(look.palette.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
  ctx.fillStyle = mixHex(look.palette.wall, BLACK, 0.3);
  ctx.beginPath();
  ctx.arc(cx, cy, 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = mixHex(look.palette.accent, WHITE, 0.6);
  ctx.beginPath();
  ctx.arc(cx, cy, 0.09, 0, Math.PI * 2);
  ctx.fill();
};

const DRUM_PAINT = ["#3e5a7a", "#7a3e2e", "#5e6b3a", "#6b6f75"] as const;

const drawBarrels: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const seed = hashKey(prop.key);
  const pick = Math.floor(hash01(seed) * DRUM_PAINT.length);
  const base = mixHex(DRUM_PAINT[pick] ?? DRUM_PAINT[0], look.palette.wall, 0.25);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const cx = x + 0.5 + (hash01(seed, x, y) - 0.5) * 0.08;
      const cy = y + 0.5 + (hash01(seed, y, x) - 0.5) * 0.08;
      ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
      ctx.beginPath();
      ctx.arc(cx + 0.07, cy + 0.1, 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(cx, cy, 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(mixHex(base, BLACK, 0.6), 0.9);
      ctx.lineWidth = hairline(look);
      ctx.stroke();
      ctx.strokeStyle = rgba(mixHex(base, WHITE, 0.45), 0.6);
      ctx.beginPath();
      ctx.arc(cx, cy, 0.26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rgba(BLACK, 0.5);
      ctx.beginPath();
      ctx.arc(cx + 0.13, cy - 0.1, 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

const drawRock: PropDrawer = (ctx, prop, look) => {
  const r = prop.rect;
  const seed = hashKey(prop.key);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w * 0.48;
  const ry = r.h * 0.46;
  const stone = mixHex(look.palette.wall, look.palette.floor, 0.35);
  const outline = (dx: number, dy: number, k: number) => {
    ctx.beginPath();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const wobble = 0.78 + hash01(seed, i) * 0.22;
      const x = cx + dx + Math.cos(a) * rx * wobble * k;
      const y = cy + dy + Math.sin(a) * ry * wobble * k;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  outline(0.08, 0.12, 1);
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fill();
  outline(0, 0, 1);
  ctx.fillStyle = stone;
  ctx.fill();
  outline(-0.1 * r.w, -0.1 * r.h, 0.55);
  ctx.fillStyle = mixHex(stone, WHITE, 0.15);
  ctx.fill();
};

/** One drawing per kind; the `Record` makes a new kind in content a type error here. */
export const PROP_DRAWERS: Readonly<Record<DockPropKind, PropDrawer>> = {
  crates: drawCrates,
  container: drawContainer,
  crane: drawCrane,
  hullSection: drawHullSection,
  planter: drawPlanter,
  conveyor: drawConveyor,
  bollard: drawBollard,
  lamp: drawLamp,
  barrels: drawBarrels,
  rock: drawRock,
};

export function drawProp(ctx: CanvasRenderingContext2D, prop: DockPropDef, look: PropLook): void {
  PROP_DRAWERS[prop.kind](ctx, prop, look);
}
