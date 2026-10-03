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
import type { PhysicalLocation, TileCoord } from "./types/common";
import type { ContentBundle, DockDef } from "./types/content";
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
