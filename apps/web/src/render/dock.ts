/**
 * Dockside §2.3 layer 4, §2.7 and §3.4 (phase 2): where the dock map is, relative to the ship, at a
 * given moment, and what the camera frames. Pure geometry; the drawing is in `dockArt.ts`.
 *
 * Frames. The sim grafts the dock onto the deck's grid at `shipAt` (D59), the ship's place in the
 * map's berth box (`berthPlacement`, D72; `berthInView` here), so dock tile (x, y) is deck tile
 * (x − shipAt.x, y − shipAt.y) and a person on the dock is an ordinary deck position,
 * possibly at negative coordinates. The renderer adds one thing: the scene's berth offset, so the
 * dock (and everyone on it) slides in from the fore (+x, `orientation.ts`) while docking and
 * drifts aft while undocking, exactly as the phase 1 berth did. The ship's own tiles never move.
 */
import {
  type BerthedDock,
  type DockDef,
  type DockDefId,
  type RenderFrame,
  type RenderTravel,
  type TileCoord,
  berthPlacement,
  dockForPort,
} from "@crew/sim";
import type { DeckLayout } from "./deckLayout";
import type { Bounds } from "./hull";
import { aftOf } from "./orientation";
import { type Scene, portInView, smooth } from "./scene";

export type DockTable = Readonly<Record<DockDefId, DockDef>>;

/**
 * Which dock map the frame shows. From the start of `docking` to the end of `undocking` the sim
 * names the dock alongside (`RenderFrame.dock`, D61) and that is the one drawn. Either side of that
 * window (`approaching`, `departing`) nothing is alongside, but the port's dock is still in view,
 * sliding in or falling astern, so it comes from content: the dock whose `portId` is the port in
 * view. During `transit` that is the destination's, drawn nowhere (the scene's `portAlpha` is 0).
 *
 * `undefined` means the port has no dock map: the caller draws the phase 1 stand-in berth. Throws
 * if the frame names a dock the content lacks: the worker runs the same bundle, so that is a bug.
 */
export function dockInView(
  frame: Pick<RenderFrame, "travel" | "dock">,
  docks: DockTable,
): DockDef | undefined {
  if (frame.dock !== undefined) {
    const alongside = docks[frame.dock.dockId];
    if (alongside === undefined) throw new Error(`dockInView: unknown dock "${frame.dock.dockId}"`);
    return alongside;
  }
  return dockForPort({ docks }, portInView(frame.travel));
}

/** `dock` with the layout's deck in its berth box, as the sim grafts it (D72). */
export function berthInView(
  dock: DockDef,
  layout: Pick<DeckLayout, "deckId" | "width" | "height" | "hull">,
): BerthedDock {
  const deck = { id: layout.deckId, width: layout.width, height: layout.height, hull: layout.hull };
  return { dock, shipAt: berthPlacement(dock, deck) };
}

/**
 * Deck-frame position of dock tile (0,0) for this scene: the graft at `shipAt`, slid along the
 * ship by the berth offset (deck lengths, positive aft). 0 slide when docked or under reduced
 * motion.
 */
export function dockOrigin(
  berth: Pick<BerthedDock, "shipAt">,
  scene: Pick<Scene, "portOffset">,
  deckWidth: number,
): TileCoord {
  return { x: -berth.shipAt.x + dockSlide(scene, deckWidth), y: -berth.shipAt.y };
}

/**
 * How far the dock and everything on it is drawn from its grafted place, tiles along deck x: the
 * scene's berth offset (deck lengths, positive astern) turned aft, so an arriving dock (negative
 * offset, ahead) is at +x and a departing one falls toward −x.
 */
export function dockSlide(scene: Pick<Scene, "portOffset">, deckWidth: number): number {
  return aftOf(scene.portOffset * deckWidth);
}

/** The ship's deck rectangle in dock tiles: its place in the berth box (D72). */
export function shipInDock(
  { shipAt }: Pick<BerthedDock, "shipAt">,
  layout: Pick<DeckLayout, "width" | "height">,
): Bounds {
  return {
    minX: shipAt.x,
    minY: shipAt.y,
    maxX: shipAt.x + layout.width,
    maxY: shipAt.y + layout.height,
  };
}

/** The whole dock map in deck coordinates as grafted (no slide). */
export function dockRectOnDeck({ dock, shipAt }: BerthedDock): Bounds {
  return {
    minX: -shipAt.x,
    minY: -shipAt.y,
    maxX: dock.width - shipAt.x,
    maxY: dock.height - shipAt.y,
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
 * The frame as drawn: people and loose items on the dock (`onDock`, D61) move with it while it
 * slides (their positions are in the grafted frame, so they already assume it is alongside);
 * everyone aboard stays put. The dock's own people and props (D66) are always on it, so they all
 * move. Carried items ride their carrier, so they follow. Returns the frame
 * itself when nothing slides, which is every docked frame.
 *
 * Nobody crosses a ramp while the dock slides (ramps open only once `docked` and are up again
 * before `undocking`), so the split never makes anyone jump.
 */
export function withDockSlide(frame: RenderFrame, slide: number): RenderFrame {
  if (slide === 0) return frame;
  return {
    ...frame,
    actors: frame.actors.map((a) => (a.onDock ? { ...a, x: a.x + slide } : a)),
    items: frame.items.map((item) => {
      const loc = item.location;
      if (loc.kind !== "deck" || !loc.onDock) return item;
      return { ...item, location: { ...loc, x: loc.x + slide } };
    }),
    locals: frame.locals.map((local) => ({ ...local, x: local.x + slide })),
    dockProps: frame.dockProps.map((prop) => ({ ...prop, x: prop.x + slide })),
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
