/**
 * Tap-to-select (§what-a-tap-selects): what a tap at a deck-frame point selects in the picture as
 * drawn. People first, crew and the dock's locals alike, the nearest within reach; then the ship's
 * items, the staging call's props, machines, a hull scar (§hull-scars-and-ship-loss), bare deck
 * floor (its room, §room-tiers), and last a dock post or bare dock floor. A person standing at a
 * post is what a tap there means, so the post never takes the tap from them.
 */
import type { DockDef, RenderFrame } from "@crew/sim";
import type { DeckLayout } from "./deckLayout";
import { berthInView, isShipTile } from "./dock";
import { dockTargetAt } from "./dockHit";
import { type DrawSelection, deckPiles } from "./draw";
import { dockPropKey } from "./locals";
import { scarAt } from "./scars";

/** How close to a person's dot a tap must land, tiles. */
export const PERSON_HIT_RADIUS_TILES = 0.8;
/** Crates sit on a tile; tapping anywhere near its square selects the pile's top item. */
export const ITEM_HIT_RADIUS_TILES = 0.5;

/** The nearest of `points` within `radius` of (x, y), or `undefined`. */
function nearest<T extends { readonly x: number; readonly y: number }>(
  points: readonly T[],
  x: number,
  y: number,
  radius: number,
): T | undefined {
  let best: T | undefined;
  let bestDist = radius;
  for (const point of points) {
    const d = Math.hypot(point.x - x, point.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = point;
    }
  }
  return best;
}

function personAt(shown: RenderFrame, x: number, y: number): DrawSelection | undefined {
  const people: { x: number; y: number; selection: DrawSelection }[] = [
    ...shown.actors.map((a) => ({
      x: a.x,
      y: a.y,
      selection: { kind: "actor", id: a.id } as const,
    })),
    ...shown.locals.map((l) => ({
      x: l.x,
      y: l.y,
      selection: { kind: "local", id: l.id } as const,
    })),
  ];
  return nearest(people, x, y, PERSON_HIT_RADIUS_TILES)?.selection;
}

function machineAt(
  shown: RenderFrame,
  layout: DeckLayout,
  x: number,
  y: number,
): DrawSelection | undefined {
  const machineByKey = new Map(
    shown.machines
      .filter((m) => m.deckId === layout.deckId)
      .map((m) => [m.placementKey, m.id] as const),
  );
  for (const m of layout.machines) {
    const d = Math.hypot(m.center.x - x, m.center.y - y);
    if (d < PERSON_HIT_RADIUS_TILES + m.footprint.length * 0.4) {
      const id = machineByKey.get(m.placementKey);
      if (id !== undefined) return { kind: "machine", id };
    }
  }
  return undefined;
}

/** §room-tiers: the room whose floor tile (x, y) is on, or `undefined` off the ship or on void. */
export function roomAt(
  layout: Pick<DeckLayout, "width" | "height" | "tiles">,
  x: number,
  y: number,
): DrawSelection | undefined {
  // Bounds first: indexing by y * width + x would wrap an off-ship point into another row.
  if (!isShipTile(layout, x, y)) return undefined;
  const key = layout.tiles[Math.floor(y) * layout.width + Math.floor(x)]?.compartmentKey;
  return key === undefined ? undefined : { kind: "room", id: key };
}

/**
 * What a tap at deck-frame (x, y) selects. `shown` is the frame as drawn (`withDockSlide`), so
 * people and things on a sliding dock are hit where they appear; `slide` is that slide, removed
 * again for the dock map's own posts and floor. `dock` is the map in view, if any.
 */
export function pickAt(
  shown: RenderFrame,
  layout: DeckLayout,
  dock: DockDef | undefined,
  slide: number,
  x: number,
  y: number,
): DrawSelection | undefined {
  const person = personAt(shown, x, y);
  if (person !== undefined) return person;
  const pile = nearest(deckPiles(shown, layout.deckId), x, y, ITEM_HIT_RADIUS_TILES);
  if (pile !== undefined) return { kind: "item", id: pile.top.id };
  const props = shown.dockProps.map((prop, index) => ({
    x: prop.x,
    y: prop.y,
    key: dockPropKey(prop, index),
  }));
  const prop = nearest(props, x, y, ITEM_HIT_RADIUS_TILES);
  if (prop !== undefined) return { kind: "dockProp", id: prop.key };
  const machine = machineAt(shown, layout, x, y);
  if (machine !== undefined) return machine;
  const scar = isShipTile(layout, x, y) ? scarAt(shown.hull.scars, x, y) : undefined;
  if (scar !== undefined) return { kind: "scar", id: scar.id };
  const room = roomAt(layout, x, y);
  if (room !== undefined) return room;
  return dock === undefined
    ? undefined
    : dockTargetAt(berthInView(dock, layout), layout, x - slide, y);
}
