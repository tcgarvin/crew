/**
 * Dockside spike (docs/design/dockside-spike.md): a port's dock joins the ship by being grafted
 * onto the deck's nav grid in the deck's own coordinate frame. There is one frame and one
 * `deckId`; a dock tile is an ordinary `onDeck` position whose tile is dock floor
 * (`isDockTile`). The hull walls the dock off everywhere except across the ramp doors, and a
 * ramp is passable only while fully open.
 *
 * `attachDock`/`detachDock` are the only writers of `state.deck.dock` once a world is running
 * (world creation and the 3 → 4 save migration set it directly, before any cache exists). The
 * travel system calls them at the start of `docking` and the end of `undocking` (§travel-stages).
 */
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { DoorId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { DerivedCaches } from "../../core/types/pipeline";
import type { DockPresence } from "../../core/types/ship";
import type { WorldState } from "../../core/types/state";
import {
  SIDES,
  SIDE_DELTA,
  checkDockGraft,
  deckGeometry,
  doorOnEdge,
  isDockTile,
  rebuildGeometries,
} from "./geometry";
import { parseReservationKey } from "./reservations";

export { deckToDock, dockToDeck, isOnDock } from "../../core/docks";

/** What attaching or detaching needs: live state, the caches to rebuild, and content. */
export interface DockHost {
  readonly state: WorldState;
  readonly caches: DerivedCaches;
  readonly content: ContentBundle;
}

/** The dock floor tile (deck frame) a ramp door lands on; throws if no dock is attached there. */
export function rampLanding(geometry: DeckGeometry, rampId: DoorId): TileCoord {
  const landing = geometry.dock?.landings.get(rampId);
  if (landing === undefined) {
    throw new Error(`Ramp ${rampId} has no landing on deck "${geometry.deckId}" (no dock?)`);
  }
  return landing;
}

/**
 * The ship tile at the top of a ramp (deck frame): the tile across the ramp door from its
 * landing. Throws if no dock is attached there.
 */
export function rampTop(geometry: DeckGeometry, rampId: DoorId): TileCoord {
  const landing = rampLanding(geometry, rampId);
  for (const side of SIDES) {
    if (doorOnEdge(geometry, landing, side) !== rampId) continue;
    const delta = SIDE_DELTA[side];
    return { x: landing.x + delta.x, y: landing.y + delta.y };
  }
  throw new Error(`Ramp ${rampId} is not on an edge of its landing ${landing.x},${landing.y}`);
}

/** Every ramp on the deck that has a landing on the dock alongside. */
export function dockRamps(geometry: DeckGeometry): DoorId[] {
  return [...(geometry.dock?.landings.keys() ?? [])];
}

/**
 * Bring a dock alongside: record it in state, bump the geometry revision and rebuild the nav
 * grids now, so the rest of this tick sees the dock. Throws, changing nothing, if a dock is
 * already attached, the layout is not in content, its floor overlaps the ship, or a ramp would
 * open onto anything but dock floor (content validation should make the last two impossible).
 */
export function attachDock(host: DockHost, presence: DockPresence): void {
  const current = host.state.deck.dock;
  if (current !== undefined) {
    throw new Error(`Dock "${current.dockId}" is already alongside; detach it first`);
  }
  checkDockGraft(host.content, host.state, presence);
  host.state.deck.dock = presence;
  host.state.deck.geometryRevision += 1;
  rebuildGeometries(host.caches, host.content, host.state);
}

/** On-deck actors and items standing on dock tiles, as `kind:id` labels. */
export function occupantsOfDock(host: Pick<DockHost, "state" | "caches">): string[] {
  const presence = host.state.deck.dock;
  if (presence === undefined) return [];
  const geometry = deckGeometry(host.caches, presence.deckId);
  const onDock = ({ location: l }: { location: PhysicalLocation }) =>
    l.kind === "onDeck" && l.deckId === presence.deckId && isDockTile(geometry, l.x, l.y);
  return [
    ...Object.values(host.state.actors)
      .filter(onDock)
      .map((actor) => `actor:${actor.id}`),
    ...Object.values(host.state.items)
      .filter(onDock)
      .map((item) => `item:${item.id}`),
  ];
}

/**
 * Take the dock away: forget per-tile state on its tiles, clear it from state, bump the geometry
 * revision and rebuild now. Throws if nothing is attached, a ramp on that deck is not fully
 * closed, or anyone or anything is still on the dock: whoever drives departure must bring people
 * aboard (or send them through the gate), clear freight and raise the ramps first, so nobody is
 * left on tiles that no longer exist. Requiring closed ramps also covers someone mid-step in a
 * ramp's aperture, since the door system never closes a ramp over an occupant.
 */
export function detachDock(host: DockHost): void {
  const presence = host.state.deck.dock;
  if (presence === undefined) throw new Error("No dock is alongside");
  const geometry = deckGeometry(host.caches, presence.deckId);
  const lowered = [...geometry.doors.values()]
    .filter((nav) => nav.placement.kind === "ramp")
    .filter((nav) => host.state.doors[nav.id]?.physicalState !== "closed")
    .map((nav) => nav.placement.key);
  if (lowered.length > 0) {
    throw new Error(
      `Cannot detach dock "${presence.dockId}": ramps not closed: ${lowered.join(", ")}`,
    );
  }
  const left = occupantsOfDock(host);
  if (left.length > 0) {
    throw new Error(`Cannot detach dock "${presence.dockId}": still on it: ${left.join(", ")}`);
  }
  const tiles = host.state.deck.tiles[presence.deckId] ?? {};
  for (const key of Object.keys(tiles) as (keyof typeof tiles)[]) {
    const [x, y] = key.split(",").map(Number);
    if (isDockTile(geometry, x ?? Number.NaN, y ?? Number.NaN)) delete tiles[key];
  }
  const reservations = host.caches.nav.reservations;
  for (const key of Object.keys(reservations)) {
    const { tile } = parseReservationKey(key);
    if (isDockTile(geometry, tile.x, tile.y)) delete reservations[key];
  }
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete host.state.deck.dock;
  host.state.deck.geometryRevision += 1;
  rebuildGeometries(host.caches, host.content, host.state);
}
