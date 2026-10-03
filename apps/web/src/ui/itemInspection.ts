/**
 * Polish A: build the inspector's view of a tapped item from a state snapshot — its name, count,
 * where it is in plain words, and, for freight, whose it is and where it is going (D28).
 *
 * Dockside phase 2: the dock is grafted onto the deck's grid (D59), so an `onDeck` item may be on
 * the dock, at coordinates outside the ship (negative ones included); it is described by the
 * dock's areas and posts rather than looked up as a room.
 */
import type { ContentBundle, DeepReadonly, DockDef, ItemId, WorldState } from "@crew/sim";
import type { DeckLayout } from "../render/deckLayout";
import { isShipTile } from "../render/dock";
import type { ItemInspection } from "./Inspector";

const AREA_WORDS = {
  freightStaging: "in the freight staging area",
  deliveryBay: "in the delivery bay",
} as const;

/** How close to a post an item must be to be described as by it, tiles. */
const NEAR_POST_TILES = 2;

/** Words for a point on the dock, in the deck frame: its area, else the nearest post, else "on the dock". */
export function dockWhere(dock: DockDef, deckX: number, deckY: number): string {
  const x = Math.floor(deckX) + dock.shipAt.x;
  const y = Math.floor(deckY) + dock.shipAt.y;
  for (const area of dock.areas) {
    const r = area.rect;
    if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) {
      return `${AREA_WORDS[area.kind]} on the dock`;
    }
  }
  let nearest: { name: string; d: number } | undefined;
  for (const post of dock.posts) {
    const d = Math.hypot(post.tile.x - x, post.tile.y - y);
    if (d <= NEAR_POST_TILES && (nearest === undefined || d < nearest.d)) {
      nearest = { name: post.name, d };
    }
  }
  return nearest === undefined ? "on the dock" : `on the dock by ${nearest.name}`;
}

function where(
  state: DeepReadonly<WorldState>,
  location: DeepReadonly<WorldState["items"][ItemId]["location"]>,
  content: ContentBundle,
  layout: DeckLayout,
  dock: DockDef | undefined,
): string {
  switch (location.kind) {
    case "onDeck": {
      if (!isShipTile(layout, location.x, location.y)) {
        return dock === undefined ? "on deck" : dockWhere(dock, location.x, location.y);
      }
      const tile = layout.tiles[Math.floor(location.y) * layout.width + Math.floor(location.x)];
      const room =
        tile?.compartmentKey === undefined
          ? undefined
          : layout.compartmentNames[tile.compartmentKey];
      return room === undefined ? "on deck" : `in the ${room.toLowerCase()}`;
    }
    case "carriedBy":
    case "equippedBy":
      return `carried by ${state.actors[location.actorId]?.name ?? "someone"}`;
    case "inContainer":
      return "packed in a container";
    case "installedIn":
      return "installed in a machine";
    case "inExternalStore":
      return `ashore at ${content.ports[location.portId]?.name ?? location.portId}`;
  }
}

/**
 * `dock` is the dock map alongside (`dockInView`), or `undefined` when the port has none or the
 * ship is between ports.
 */
export function inspectItem(
  state: DeepReadonly<WorldState>,
  itemId: ItemId,
  content: ContentBundle,
  layout: DeckLayout,
  dock: DockDef | undefined,
): ItemInspection | undefined {
  const item = state.items[itemId];
  if (item === undefined) return undefined;
  const def = content.items[item.defId] ?? state.defs.dynamic.items[item.defId];
  const job = item.jobId === undefined ? undefined : state.jobs[item.jobId];
  const port = (id: string) => content.ports[id as keyof ContentBundle["ports"]]?.name ?? id;
  return {
    name: def?.name ?? "Cargo",
    count: item.stacking === "stack" ? item.count : 1,
    where: where(state, item.location, content, layout, dock),
    ...(job === undefined
      ? {}
      : {
          job: {
            issuer: job.issuer,
            from: port(job.fromPortId),
            to: port(job.toPortId),
            status: job.status,
          },
        }),
  };
}
