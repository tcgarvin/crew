/**
 * Dock maps as the kernel reads them (Dockside §3, D59, D60): pure over content and state, with
 * no nav cache, so core (world creation, migrations, the render projection) and every system
 * share one implementation. `systems/spatial` grafts the walkable floor this module defines onto
 * the deck's nav grid (`geometry.ts`, `dock.ts`).
 *
 * Frames: a dock map has its own tile frame; the ship's deck tile (0,0) sits on dock tile
 * `shipAt`, so dock tile (x, y) is deck tile (x − shipAt.x, y − shipAt.y). Everything in state
 * is in the deck frame.
 */
import type { EdgeSide, PhysicalLocation, TileCoord } from "./types/common";
import type {
  ContentBundle,
  DockAreaKind,
  DockDef,
  DockPostDef,
  DockPostKind,
} from "./types/content";
import type { PortDefId } from "./types/ids";
import type { DockPresence } from "./types/ship";
import type { TravelState } from "./types/travel";

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

/** Dock-frame tile → deck-frame tile. */
export function dockToDeck(layout: Pick<DockDef, "shipAt">, tile: TileCoord): TileCoord {
  return { x: tile.x - layout.shipAt.x, y: tile.y - layout.shipAt.y };
}

/** Deck-frame tile → dock-frame tile. */
export function deckToDock(layout: Pick<DockDef, "shipAt">, tile: TileCoord): TileCoord {
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
 * The port whose dock is alongside at this travel stage (D61): from the start of `docking` to
 * the end of `undocking`. `docking` is at the port being made for, `docked` at its own port,
 * `preparingDeparture` and `undocking` still at the port being left. Undefined in flight.
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

/** The dock content says should be alongside right now (D61's lifetime rule), if any. */
export function expectedDock(
  content: Pick<ContentBundle, "docks">,
  travel: TravelState,
): DockDef | undefined {
  const portId = dockedPortOf(travel);
  return portId === undefined ? undefined : dockForPort(content, portId);
}

/** Is deck-frame point (x, y) on the floor of the dock alongside? False with no dock attached. */
export function isDockPoint(
  content: Pick<ContentBundle, "docks">,
  state: { readonly deck: { readonly dock?: DockPresence } },
  x: number,
  y: number,
): boolean {
  const presence = state.deck.dock;
  if (presence === undefined) return false;
  const layout = content.docks?.[presence.dockId];
  if (layout === undefined) throw new Error(`No dock layout "${presence.dockId}" in content`);
  return isDockFloor(layout, Math.floor(x) + layout.shipAt.x, Math.floor(y) + layout.shipAt.y);
}

/**
 * Is this location on the dock alongside? Pure over state and content (no nav cache), for code
 * that must tell "aboard" from "ashore": the render projection, commerce custody, departure.
 * With the graft (D59), `onDeck` alone no longer means aboard.
 */
export function isOnDock(
  content: Pick<ContentBundle, "docks">,
  state: { readonly deck: { readonly dock?: DockPresence } },
  location: PhysicalLocation,
): boolean {
  const presence = state.deck.dock;
  if (presence === undefined || location.kind !== "onDeck") return false;
  if (location.deckId !== presence.deckId) return false;
  return isDockPoint(content, state, location.x, location.y);
}

// ---------------------------------------------------------------------------------------------
// Posts and areas (D63): where port work happens on the dock, in the deck frame
// ---------------------------------------------------------------------------------------------

/** The dock alongside right now (`state.deck.dock`), if any. Throws if content lost its map. */
export function dockAlongside(
  content: Pick<ContentBundle, "docks">,
  state: { readonly deck: { readonly dock?: DockPresence } },
): DockDef | undefined {
  const presence = state.deck.dock;
  if (presence === undefined) return undefined;
  const dock = content.docks?.[presence.dockId];
  if (dock === undefined) throw new Error(`No dock layout "${presence.dockId}" in content`);
  return dock;
}

/** The dock alongside if it is `portId`'s, else undefined (no dock, or another port's). */
export function dockAlongsideAt(
  content: Pick<ContentBundle, "docks">,
  state: { readonly deck: { readonly dock?: DockPresence } },
  portId: PortDefId,
): DockDef | undefined {
  const dock = dockAlongside(content, state);
  return dock?.portId === portId ? dock : undefined;
}

/**
 * Every tile of the dock's first area of `kind`, deck frame, row by row. Empty when the map has
 * none (content validation requires one staging area and one delivery bay per authored dock).
 */
export function dockAreaTiles(dock: DockDef, kind: DockAreaKind): TileCoord[] {
  const area = dock.areas.find((a) => a.kind === kind);
  if (area === undefined) return [];
  const tiles: TileCoord[] = [];
  const { x, y, w, h } = area.rect;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) tiles.push(dockToDeck(dock, { x: x + dx, y: y + dy }));
  }
  return tiles;
}

/** Is deck-frame point (x, y) inside the dock's first area of `kind`? */
export function inDockArea(dock: DockDef, kind: DockAreaKind, x: number, y: number): boolean {
  const area = dock.areas.find((a) => a.kind === kind);
  if (area === undefined) return false;
  const tile = deckToDock(dock, { x: Math.floor(x), y: Math.floor(y) });
  const { rect } = area;
  return (
    tile.x >= rect.x && tile.x < rect.x + rect.w && tile.y >= rect.y && tile.y < rect.y + rect.h
  );
}

/**
 * Is this location in the `kind` area of the dock alongside? Pure over state and content: the
 * delivery bay's custody check (D63) and the narrator's "On the dock" lines read it.
 */
export function isInDockArea(
  content: Pick<ContentBundle, "docks">,
  state: { readonly deck: { readonly dock?: DockPresence } },
  location: PhysicalLocation,
  kind: DockAreaKind,
): boolean {
  if (location.kind !== "onDeck") return false;
  const presence = state.deck.dock;
  if (presence === undefined || location.deckId !== presence.deckId) return false;
  const dock = dockAlongside(content, state);
  return dock !== undefined && inDockArea(dock, kind, location.x, location.y);
}

/** The dock's first post of `kind`, if it has one (a dock may have no market stall). */
export function dockPost(dock: DockDef, kind: DockPostKind): DockPostDef | undefined {
  return dock.posts.find((p) => p.kind === kind);
}

const FACING_STEP: Readonly<Record<EdgeSide, TileCoord>> = {
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
export function postServiceTile(dock: DockDef, post: DockPostDef): TileCoord {
  const step = FACING_STEP[post.facing];
  const front = { x: post.tile.x + step.x, y: post.tile.y + step.y };
  return dockToDeck(dock, isDockFloor(dock, front.x, front.y) ? front : post.tile);
}

/** A post's own tile, deck frame (the gate: where someone walks out of the simulated world). */
export function postTile(dock: DockDef, post: DockPostDef): TileCoord {
  return dockToDeck(dock, post.tile);
}

/** The gate tile of the dock alongside at `portId`, deck frame, if that dock has a gate. */
export function gateTileAt(
  content: Pick<ContentBundle, "docks">,
  state: { readonly deck: { readonly dock?: DockPresence } },
  portId: PortDefId,
): TileCoord | undefined {
  const dock = dockAlongsideAt(content, state, portId);
  const gate = dock === undefined ? undefined : dockPost(dock, "gate");
  return dock === undefined || gate === undefined ? undefined : postTile(dock, gate);
}

/**
 * Where a port's market is dealt with (D47, D63):
 * - `stall`: the dock's market stall, standing at its counter (`tile`); the units are handed over
 *   there and carried aboard;
 * - `gate`: a dock with no stall has its market through the gate (`tile`): the buyer walks out,
 *   is off ship for the purchase, and comes back with the units;
 * - `transferTile`: no dock alongside (or a hand-built dock with neither post; content validation
 *   requires a gate): the units come over the ramp to a cargo transfer tile, as before.
 */
export type MarketCounter =
  | { readonly kind: "stall"; readonly tile: TileCoord }
  | { readonly kind: "gate"; readonly tile: TileCoord }
  | { readonly kind: "transferTile" };

export function marketCounter(
  content: Pick<ContentBundle, "docks">,
  state: { readonly deck: { readonly dock?: DockPresence } },
  portId: PortDefId,
): MarketCounter {
  const dock = dockAlongsideAt(content, state, portId);
  if (dock === undefined) return { kind: "transferTile" };
  const stall = dockPost(dock, "marketStall");
  if (stall !== undefined) return { kind: "stall", tile: postServiceTile(dock, stall) };
  const gate = gateTileAt(content, state, portId);
  return gate === undefined ? { kind: "transferTile" } : { kind: "gate", tile: gate };
}
