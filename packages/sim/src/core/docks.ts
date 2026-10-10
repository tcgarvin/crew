/**
 * Dock maps as the kernel reads them (Dockside §3, D59, §dock-map-content): pure over content and
 * state, with no nav cache, so core (world creation, migrations, the render projection) and every
 * system share one implementation. `systems/spatial` grafts the walkable floor this module defines
 * onto the deck's nav grid (`geometry.ts`, `dock.ts`).
 *
 * Frames: a dock map has its own tile frame. The ship lies in the map's berth box
 * (§ship-placement), at the place `berthPlacement` derives from the box and the deck: the ship's
 * deck tile (0,0) sits on dock tile `shipAt`, so dock tile (x, y) is deck tile (x − shipAt.x, y −
 * shipAt.y). A `BerthedDock` carries a map with that place; everything in state is in the deck
 * frame.
 */
import type { EdgeSide, PhysicalLocation, TileCoord } from "./types/common";
import {
  type ContentBundle,
  type DeckDef,
  type DockAreaKind,
  type DockDef,
  type DockPostDef,
  type DockPostKind,
  HULL_SIZE_BOX,
} from "./types/content";
import type { PortDefId } from "./types/ids";
import type { DockPresence } from "./types/ship";
import type { TravelState } from "./types/travel";

/** The slice of state that says which dock, if any, is alongside. */
type DockHost = { readonly deck: { readonly dock?: DockPresence } };

/** The content a dock's frame needs: the maps, and the decks whose footprint places the ship. */
type DockContent = Pick<ContentBundle, "docks" | "decks">;

/**
 * §ship-placement: a dock map with the ship's place in it, derived from the berth box and the deck.
 */
export interface BerthedDock {
  readonly dock: DockDef;
  /** Dock tile under deck tile (0,0). */
  readonly shipAt: TileCoord;
}

/** What placing a ship in a berth reads from its deck: the footprint and its size class. */
export type BerthingDeck = Pick<DeckDef, "id" | "width" | "height" | "hull">;

/**
 * §ship-placement: where `deck` lies in `dock`'s berth box (the dock tile under deck tile (0,0)):
 * flush to the box's south edge, the quay side, and centred across it (a remainder tile goes east).
 * Throws if the deck is larger than its own size class, or its class larger than the box's, which
 * content validation rules out for authored content.
 */
export function berthPlacement(dock: Pick<DockDef, "id" | "berth">, deck: BerthingDeck): TileCoord {
  const own = HULL_SIZE_BOX[deck.hull.sizeClass];
  if (deck.width > own.w || deck.height > own.h) {
    throw new Error(
      `Deck "${deck.id}" (${deck.width} x ${deck.height}) exceeds its ${deck.hull.sizeClass} box (${own.w} x ${own.h})`,
    );
  }
  const box = HULL_SIZE_BOX[dock.berth.sizeClass];
  if (own.w > box.w || own.h > box.h) {
    throw new Error(
      `Dock "${dock.id}": a ${dock.berth.sizeClass} berth cannot take "${deck.id}" (class ${deck.hull.sizeClass})`,
    );
  }
  const { origin } = dock.berth;
  return {
    x: origin.x + Math.floor((box.w - deck.width) / 2),
    y: origin.y + box.h - deck.height,
  };
}

const berthed = new WeakMap<DockDef, WeakMap<BerthingDeck, BerthedDock>>();

/** `dock` with `deck` in its berth. Memoized per pair (defs are immutable). */
export function berthDock(dock: DockDef, deck: BerthingDeck): BerthedDock {
  let byDeck = berthed.get(dock);
  if (byDeck === undefined) {
    byDeck = new WeakMap();
    berthed.set(dock, byDeck);
  }
  const cached = byDeck.get(deck);
  if (cached !== undefined) return cached;
  const value: BerthedDock = { dock, shipAt: berthPlacement(dock, deck) };
  byDeck.set(deck, value);
  return value;
}

const floorMasks = new WeakMap<DockDef, Uint8Array>();

/**
 * Walkable dock floor, row-major in the dock's own frame (`y * width + x`): a `floor` tile under
 * no blocking prop. Content validation applies the same rule (`packages/content`
 * `dockWalkableMask`); a CLI test holds the two together. Memoized per def (defs are immutable).
 * Throws on a malformed map, which content validation makes impossible for authored docks.
 */
export function dockFloorMask(dock: DockDef): Uint8Array {
  const cached = floorMasks.get(dock);
  if (cached !== undefined) return cached;
  if (dock.rows.length !== dock.height) {
    throw new Error(`Dock "${dock.id}": ${dock.rows.length} rows, expected ${dock.height}`);
  }
  const mask = new Uint8Array(dock.width * dock.height);
  dock.rows.forEach((row, y) => {
    if (row.length !== dock.width) {
      throw new Error(`Dock "${dock.id}": row ${y} is ${row.length} wide, expected ${dock.width}`);
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? "";
      const kind = dock.legend[ch];
      if (kind === undefined) throw new Error(`Dock "${dock.id}": "${ch}" is not in the legend`);
      if (kind === "floor") mask[y * dock.width + x] = 1;
    }
  });
  for (const prop of dock.props) {
    if (!prop.blocking) continue;
    const { x: px, y: py, w, h } = prop.rect;
    for (let y = py; y < py + h; y++) {
      for (let x = px; x < px + w; x++) {
        if (x < 0 || y < 0 || x >= dock.width || y >= dock.height) {
          throw new Error(`Dock "${dock.id}": prop "${prop.key}" reaches off the map`);
        }
        mask[y * dock.width + x] = 0;
      }
    }
  }
  floorMasks.set(dock, mask);
  return mask;
}

/** Is dock-frame tile (x, y) walkable dock floor? False off the map. */
export function isDockFloor(dock: DockDef, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= dock.width || y >= dock.height) return false;
  return dockFloorMask(dock)[y * dock.width + x] === 1;
}

/** Is deck-frame tile `tile` walkable floor of the berthed dock? */
export function isDockFloorAt(berth: BerthedDock, tile: TileCoord): boolean {
  return isDockFloor(berth.dock, tile.x + berth.shipAt.x, tile.y + berth.shipAt.y);
}

/** Dock-frame tile → deck-frame tile. */
export function dockToDeck(layout: Pick<BerthedDock, "shipAt">, tile: TileCoord): TileCoord {
  return { x: tile.x - layout.shipAt.x, y: tile.y - layout.shipAt.y };
}

/** Deck-frame tile → dock-frame tile. */
export function deckToDock(layout: Pick<BerthedDock, "shipAt">, tile: TileCoord): TileCoord {
  return { x: tile.x + layout.shipAt.x, y: tile.y + layout.shipAt.y };
}

/**
 * The dock map authored for `portId`, or undefined for a port without one (hand-built test
 * bundles; such a port keeps the transfer-tile behaviour). Throws if content has two, which
 * content validation forbids, rather than pick one silently.
 */
export function dockForPort(
  content: Pick<ContentBundle, "docks">,
  portId: PortDefId,
): DockDef | undefined {
  const matches = Object.values(content.docks ?? {}).filter((d) => d.portId === portId);
  if (matches.length > 1) {
    throw new Error(`Port "${portId}" has ${matches.length} dock maps; expected at most one`);
  }
  return matches[0];
}

/**
 * The port whose dock is alongside at this travel stage (§dock-alongside): from the start of
 * `docking` to the end of `undocking`. `docking` is at the port being made for, `docked` at its own
 * port, `preparingDeparture` and `undocking` still at the port being left. Undefined in flight.
 */
export function dockedPortOf(travel: TravelState): PortDefId | undefined {
  switch (travel.stage) {
    case "docked":
      return travel.portId;
    case "docking":
      return travel.toPortId;
    case "preparingDeparture":
    case "undocking":
      return travel.fromPortId;
    case "departing":
    case "transit":
    case "approaching":
      return undefined;
  }
}

/**
 * The dock content says should be alongside right now (the §dock-alongside lifetime rule), if any.
 */
export function expectedDock(
  content: Pick<ContentBundle, "docks">,
  travel: TravelState,
): DockDef | undefined {
  const portId = dockedPortOf(travel);
  return portId === undefined ? undefined : dockForPort(content, portId);
}

/** Is deck-frame point (x, y) on the floor of the dock alongside? False with no dock attached. */
export function isDockPoint(content: DockContent, state: DockHost, x: number, y: number): boolean {
  const berth = dockAlongside(content, state);
  return berth !== undefined && isDockFloorAt(berth, { x: Math.floor(x), y: Math.floor(y) });
}

/**
 * Is this location on the dock alongside? Pure over state and content (no nav cache), for code
 * that must tell "aboard" from "ashore": the render projection, commerce custody, departure.
 * With the graft (D59), `onDeck` alone no longer means aboard.
 */
export function isOnDock(
  content: DockContent,
  state: DockHost,
  location: PhysicalLocation,
): boolean {
  const presence = state.deck.dock;
  if (presence === undefined || location.kind !== "onDeck") return false;
  if (location.deckId !== presence.deckId) return false;
  return isDockPoint(content, state, location.x, location.y);
}

// ---------------------------------------------------------------------------------------------
// Posts and areas (§dock-map-content): where port work happens on the dock, in the deck frame
// ---------------------------------------------------------------------------------------------

/**
 * The dock alongside right now (`state.deck.dock`), if any, with the ship's deck in its berth.
 * Throws if content lost the map or the deck.
 */
export function dockAlongside(content: DockContent, state: DockHost): BerthedDock | undefined {
  const presence = state.deck.dock;
  if (presence === undefined) return undefined;
  const dock = content.docks?.[presence.dockId];
  if (dock === undefined) throw new Error(`No dock layout "${presence.dockId}" in content`);
  const deck = content.decks[presence.deckId];
  if (deck === undefined) throw new Error(`No deck "${presence.deckId}" in content`);
  return berthDock(dock, deck);
}

/** The dock alongside if it is `portId`'s, else undefined (no dock, or another port's). */
export function dockAlongsideAt(
  content: DockContent,
  state: DockHost,
  portId: PortDefId,
): BerthedDock | undefined {
  const berth = dockAlongside(content, state);
  return berth?.dock.portId === portId ? berth : undefined;
}

/**
 * Every tile of the dock's first area of `kind`, deck frame, row by row. Empty when the map has
 * none (content validation requires one staging area and one delivery bay per authored dock).
 */
export function dockAreaTiles(berth: BerthedDock, kind: DockAreaKind): TileCoord[] {
  const area = berth.dock.areas.find((a) => a.kind === kind);
  if (area === undefined) return [];
  const tiles: TileCoord[] = [];
  const { x, y, w, h } = area.rect;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) tiles.push(dockToDeck(berth, { x: x + dx, y: y + dy }));
  }
  return tiles;
}

/** Is deck-frame point (x, y) inside the dock's first area of `kind`? */
function inDockArea(berth: BerthedDock, kind: DockAreaKind, x: number, y: number): boolean {
  const area = berth.dock.areas.find((a) => a.kind === kind);
  if (area === undefined) return false;
  const tile = deckToDock(berth, { x: Math.floor(x), y: Math.floor(y) });
  const { rect } = area;
  return (
    tile.x >= rect.x && tile.x < rect.x + rect.w && tile.y >= rect.y && tile.y < rect.y + rect.h
  );
}

/**
 * Is this location in the `kind` area of the dock alongside? Pure over state and content: the
 * delivery bay's custody check (§offered-freight) and the narrator's "On the dock" lines read it.
 */
export function isInDockArea(
  content: DockContent,
  state: DockHost,
  location: PhysicalLocation,
  kind: DockAreaKind,
): boolean {
  if (location.kind !== "onDeck") return false;
  const presence = state.deck.dock;
  if (presence === undefined || location.deckId !== presence.deckId) return false;
  const berth = dockAlongside(content, state);
  return berth !== undefined && inDockArea(berth, kind, location.x, location.y);
}

/** The dock's first post of `kind`, if it has one (a dock may have no market stall). */
export function dockPost(dock: DockDef, kind: DockPostKind): DockPostDef | undefined {
  return dock.posts.find((p) => p.kind === kind);
}

/** One tile's step towards each side. */
export const EDGE_STEP: Readonly<Record<EdgeSide, TileCoord>> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

/**
 * Where a visitor stands to deal with a post, deck frame: the floor tile the post faces (the
 * counter's customer side), or the post's own tile if that one is not walkable. Keeps the post
 * tile itself free for whoever works there (locals, phase 3).
 */
export function postServiceTile(berth: BerthedDock, post: DockPostDef): TileCoord {
  const step = EDGE_STEP[post.facing];
  const front = { x: post.tile.x + step.x, y: post.tile.y + step.y };
  return dockToDeck(berth, isDockFloor(berth.dock, front.x, front.y) ? front : post.tile);
}

/** A post's own tile, deck frame (the gate: where someone walks out of the simulated world). */
export function postTile(berth: Pick<BerthedDock, "shipAt">, post: DockPostDef): TileCoord {
  return dockToDeck(berth, post.tile);
}

/** The gate tile of the dock alongside at `portId`, deck frame, if that dock has a gate. */
export function gateTileAt(
  content: DockContent,
  state: DockHost,
  portId: PortDefId,
): TileCoord | undefined {
  const berth = dockAlongsideAt(content, state, portId);
  const gate = berth === undefined ? undefined : dockPost(berth.dock, "gate");
  return berth === undefined || gate === undefined ? undefined : postTile(berth, gate);
}

/**
 * Where a port's market is dealt with (§buying-parts, §dock-market-and-passengers):
 * - `stall`: the dock's market stall, standing at its counter (`tile`); the units are handed over
 *   there and carried aboard;
 * - `gate`: a dock with no stall has its market through the gate (`tile`): the buyer walks out,
 *   is off ship for the purchase, and comes back with the units;
 * - `transferTile`: no dock alongside (or a hand-built dock with neither post; content validation
 *   requires a gate): the units come over the ramp to a cargo transfer tile, as before.
 */
type MarketCounter =
  | { readonly kind: "stall"; readonly tile: TileCoord }
  | { readonly kind: "gate"; readonly tile: TileCoord }
  | { readonly kind: "transferTile" };

export function marketCounter(
  content: DockContent,
  state: DockHost,
  portId: PortDefId,
): MarketCounter {
  const berth = dockAlongsideAt(content, state, portId);
  if (berth === undefined) return { kind: "transferTile" };
  const stall = dockPost(berth.dock, "marketStall");
  if (stall !== undefined) return { kind: "stall", tile: postServiceTile(berth, stall) };
  const gate = gateTileAt(content, state, portId);
  return gate === undefined ? { kind: "transferTile" } : { kind: "gate", tile: gate };
}
