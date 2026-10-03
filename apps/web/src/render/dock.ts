/**
 * Dockside §2.3 layer 4, §2.7 and §3.4 (phase 2): where the dock map is, relative to the ship, at a
 * given moment, and what the camera frames. Pure geometry; the drawing is in `dockArt.ts`.
 *
 * Frames. The sim grafts the dock onto the deck's grid at `shipAt` (D59), so dock tile (x, y) is
 * deck tile (x − shipAt.x, y − shipAt.y) and a person on the dock is an ordinary deck position,
 * possibly at negative coordinates. The renderer adds one thing: the scene's berth offset, so the
 * dock (and everyone on it) slides in from the fore while docking and drifts aft while undocking,
 * exactly as the phase 1 berth did. The ship's own tiles never move.
 */
import type {
  DockDef,
  DockDefId,
  PortDefId,
  RenderFrame,
  RenderTravel,
  TileCoord,
} from "@crew/sim";
import type { DeckLayout } from "./deckLayout";
import type { Bounds } from "./hull";
import { type Scene, portInView, smooth } from "./scene";

export type DockTable = Readonly<Record<DockDefId, DockDef>>;

const byPortCache = new WeakMap<DockTable, ReadonlyMap<PortDefId, DockDef>>();

function docksByPort(docks: DockTable): ReadonlyMap<PortDefId, DockDef> {
  const cached = byPortCache.get(docks);
  if (cached !== undefined) return cached;
  const index = new Map<PortDefId, DockDef>();
  for (const dock of Object.values(docks)) {
    if (index.has(dock.portId)) {
      throw new Error(`Two dock maps for port "${dock.portId}"; content allows at most one`);
    }
    index.set(dock.portId, dock);
  }
  byPortCache.set(docks, index);
  return index;
}

/**
 * THE SEAM (phase 2, item 10): which dock map the frame shows. Until the sim's `RenderFrame`
 * carries the attached dock, this derives it from content: the dock whose `portId` is the port in
 * view (the one being left until transit, then the destination), so the dock is drawn sliding in
 * during `approaching`/`docking` and away during `undocking`/`departing` as well as docked. The
 * sim's field will only name a dock from the start of `docking` to the end of `undocking`; prefer
 * it when present and keep this lookup for the stages either side.
 *
 * `undefined` means the port has no dock map: the caller draws the phase 1 stand-in berth.
 */
export function dockInView(
  frame: { readonly travel: Pick<RenderTravel, "state" | "fromPortId" | "toPortId"> },
  docks: DockTable,
): DockDef | undefined {
  return docksByPort(docks).get(portInView(frame.travel));
}

/**
 * Deck-frame position of dock tile (0,0) for this scene: the graft at `shipAt`, slid along the
 * ship by the berth offset (deck lengths, positive aft). 0 slide when docked or under reduced
 * motion.
 */
export function dockOrigin(
  dock: Pick<DockDef, "shipAt">,
  scene: Pick<Scene, "portOffset">,
  deckWidth: number,
): TileCoord {
  return { x: -dock.shipAt.x + dockSlide(scene, deckWidth), y: -dock.shipAt.y };
}

/** How far the dock and everything on it is drawn from its grafted place, tiles along +x. */
export function dockSlide(scene: Pick<Scene, "portOffset">, deckWidth: number): number {
  return scene.portOffset * deckWidth;
}

/** The whole dock map in deck coordinates as grafted (no slide). */
export function dockRectOnDeck(dock: Pick<DockDef, "shipAt" | "width" | "height">): Bounds {
  return {
    minX: -dock.shipAt.x,
    minY: -dock.shipAt.y,
    maxX: dock.width - dock.shipAt.x,
    maxY: dock.height - dock.shipAt.y,
  };
}

/** Is deck tile (x, y) the ship's own floor (as opposed to dock floor grafted alongside)? */
export function isShipTile(
  layout: Pick<DeckLayout, "width" | "height" | "tiles">,
  x: number,
  y: number,
): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= layout.width || ty >= layout.height) return false;
  return layout.tiles[ty * layout.width + tx]?.compartmentKey !== undefined;
}

/**
 * The frame as drawn: people and loose items standing on dock tiles move with the dock while it
 * slides (they are in the grafted frame, so their positions already assume it is alongside);
 * everyone aboard stays put. Carried items ride their carrier, so they follow. Returns the frame
 * itself when nothing slides, which is every docked frame.
 *
 * Nobody crosses a ramp while the dock slides (ramps open only once `docked` and are up again
 * before `undocking`), so the split by tile never makes anyone jump.
 */
export function withDockSlide(
  frame: RenderFrame,
  layout: Pick<DeckLayout, "deckId" | "width" | "height" | "tiles">,
  slide: number,
): RenderFrame {
  if (slide === 0) return frame;
  const onDock = (deckId: string, x: number, y: number) =>
    deckId === layout.deckId && !isShipTile(layout, x, y);
  return {
    ...frame,
    actors: frame.actors.map((a) => (onDock(a.deckId, a.x, a.y) ? { ...a, x: a.x + slide } : a)),
    items: frame.items.map((item) => {
      const loc = item.location;
      if (loc.kind !== "deck" || !onDock(loc.deckId, loc.x, loc.y)) return item;
      return { ...item, location: { ...loc, x: loc.x + slide } };
    }),
  };
}

/** How long the dock's clamps take to swing in at the end of docking, as a fraction of it. */
const CLAMP_WINDOW = 0.2;

/**
 * Docking clamps, 0 retracted to 1 engaged: they swing in over the last part of `docking`, hold
 * while berthed, and release over the first part of `undocking` (§2.4: "clamps release").
 */
export function clampEngagement(travel: Pick<RenderTravel, "state" | "progress">): number {
  const p = Math.min(1, Math.max(0, travel.progress));
  switch (travel.state) {
    case "docked":
    case "preparingDeparture":
      return 1;
    case "docking":
      return smooth((p - (1 - CLAMP_WINDOW)) / CLAMP_WINDOW);
    case "undocking":
      return 1 - smooth(p / CLAMP_WINDOW);
    case "departing":
    case "transit":
    case "approaching":
      return 0;
  }
}
