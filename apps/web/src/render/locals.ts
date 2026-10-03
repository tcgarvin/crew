/**
 * Dockside phase 3 (D66, D68): the dock's own people (`RenderFrame.locals`) and the staging call's
 * set dressing (`RenderFrame.dockProps`), drawn in screen space like the crew and the ship's items
 * so they stay upright under the portrait rotation.
 *
 * A local is a dot like a crew member's, but in a muted colour picked from their look seed, with a
 * darker rim of the same hue: never crew gold, never the passenger's pale fill and blue rim
 * (dockside §5.1). A dock hand carting crates pushes a trolley drawn like the ship's hand truck. A
 * staged prop is drawn as its item would be, muted and set out as that many small crates, never
 * with the freight's count tag, so it does not read as cargo the crew can touch.
 */
import type { RenderDockProp, RenderLocal } from "@crew/sim";
import { BLACK, mixHex } from "./color";
import { CARGO_COLORS, drawCrate, drawLoadedTruck, itemColor } from "./crates";
import { type ViewTransform, carriedSize, dotRadius, toScreenPx } from "./screen";

/**
 * Muted, mid-light hues, far from crew gold (`#f2c14e`) and the passenger's pale `#dfe9f3`, and
 * varied enough that a busy dock does not look like one family.
 */
export const LOCAL_PALETTE = [
  "#c27d6b",
  "#7fa88f",
  "#8d8fc4",
  "#b98bb0",
  "#6fa4b3",
  "#8fa26a",
  "#a27c62",
  "#7d93ab",
] as const;

export interface LocalLook {
  readonly fill: string;
  readonly rim: string;
}

/** A local's dot colours from their look seed (a uint32 hash of the name): stable per person. */
export function localLook(lookSeed: number): LocalLook {
  const index = (lookSeed >>> 0) % LOCAL_PALETTE.length;
  const fill = LOCAL_PALETTE[index] ?? LOCAL_PALETTE[0];
  return { fill, rim: mixHex(fill, BLACK, 0.55) };
}

export function drawLocalDots(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  locals: readonly RenderLocal[],
  rotated: boolean,
  viewportWidth: number,
  selectedId?: string,
): void {
  const radius = dotRadius(t);
  for (const local of locals) {
    const [cx, cy] = toScreenPx(t, local.x, local.y, rotated, viewportWidth);
    const look = localLook(local.lookSeed);
    ctx.fillStyle = look.fill;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = look.rim;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (selectedId === local.id) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * The trolley a dock hand carts crates on, beside their dot as the crew's hand truck is (D65). The
 * frame carries only how many crates ride on it, so they are drawn as general freight.
 */
export function drawLocalTrolleys(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  locals: readonly RenderLocal[],
  rotated: boolean,
  viewportWidth: number,
): void {
  const dot = dotRadius(t);
  const small = carriedSize(t);
  for (const local of locals) {
    if (local.carrying <= 0) continue;
    const [ax, ay] = toScreenPx(t, local.x, local.y, rotated, viewportWidth);
    const colors = Array.from({ length: local.carrying }, () => CARGO_COLORS.general);
    drawLoadedTruck(ctx, ax + dot + small / 2, ay, small, colors);
  }
}

/**
 * The text over a local's dot, or `undefined` for none. A local is labelled only while doing
 * something (D68): the docked phone view is already crowded with the crew's labels, and a regular
 * standing at their post says nothing a tap does not.
 */
export function localLabelText(local: Pick<RenderLocal, "name" | "label">): string | undefined {
  if (local.label === undefined) return undefined;
  const first = local.name.split(/\s+/)[0] ?? local.name;
  return `${first} — ${local.label}`;
}

/**
 * A dock prop's tap and selection key. Props are presentation records with no id (D66), set once
 * when the dock is dressed and gone with it, so their order in the frame is stable for as long as
 * they are drawn; a position would not be, since the dock slides.
 */
export function dockPropKey(prop: Pick<RenderDockProp, "defId">, index: number): string {
  return `${index}/${prop.defId}`;
}

/** Where each of a prop's units sits in its tile, as offsets from the tile centre, tiles. */
const PROP_LAYOUT: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[0, 0]],
  2: [
    [-0.2, 0],
    [0.2, 0],
  ],
  3: [
    [-0.2, 0.18],
    [0.2, 0.18],
    [0, -0.2],
  ],
  4: [
    [-0.2, -0.2],
    [0.2, -0.2],
    [-0.2, 0.2],
    [0.2, 0.2],
  ],
};

/** Dimmed toward the dock's grey, so set dressing sits behind the ship's own freight. */
const PROP_MUTE = "#4a535c";

export function dockPropColor(prop: Pick<RenderDockProp, "kind" | "cargoClass">): string {
  return mixHex(itemColor(prop), PROP_MUTE, 0.4);
}

/** The staging call's props, each as `count` small muted squares on its tile. */
export function drawDockProps(
  ctx: CanvasRenderingContext2D,
  t: ViewTransform,
  props: readonly RenderDockProp[],
  rotated: boolean,
  viewportWidth: number,
  selectedKey?: string,
): void {
  props.forEach((prop, index) => {
    const units = PROP_LAYOUT[Math.min(4, Math.max(1, Math.round(prop.count)))] ?? [];
    const size = Math.max(6, t.scale * (units.length === 1 ? 0.5 : 0.36));
    const color = dockPropColor(prop);
    for (const [dx, dy] of units) {
      const [cx, cy] = toScreenPx(t, prop.x + dx, prop.y + dy, rotated, viewportWidth);
      drawCrate(ctx, cx, cy, size, color, false);
    }
    if (selectedKey === dockPropKey(prop, index)) {
      const [cx, cy] = toScreenPx(t, prop.x, prop.y, rotated, viewportWidth);
      const side = Math.max(12, t.scale * 0.95);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - side / 2, cy - side / 2, side, side);
    }
  });
}
