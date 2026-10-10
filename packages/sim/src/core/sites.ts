/**
 * Expeditions A1 (§4, plan call 8): reading a site map. A site map is a `DockDef` of
 * `kind: "site"`, grafted alongside like any dock; these read its tile kinds, cover, posts and the
 * foot of the personnel ramp in the deck frame (the frame the fight runs in). Pure over content
 * and state; nothing is added to `DeckGeometry`.
 *
 * Cover (call 8): a `cover` legend tile, or any tile under a blocking prop, so every dock map has
 * cover already (crates, the conveyor, hull sections). Neither is walkable (`dockFloorMask`).
 */
import { type BerthedDock, deckToDock, dockAlongside } from "./docks";
import { personnelRampFoot } from "./locals";
import type { TileCoord } from "./types/common";
import type {
  ContentBundle,
  DockDef,
  DockPostDef,
  DockPostKind,
  DockTileKind,
} from "./types/content";
import type { DockPresence } from "./types/ship";

type SiteContent = Pick<ContentBundle, "docks" | "decks">;
type SiteHost = { readonly deck: { readonly dock?: DockPresence } };

/** The site map alongside, with the ship in its berth, or undefined (no dock, or a port's dock). */
export function siteOf(content: SiteContent, state: SiteHost): BerthedDock | undefined {
  const berth = dockAlongside(content, state);
  return berth?.dock.kind === "site" ? berth : undefined;
}

/**
 * The legend kind of deck-frame tile `tile` on the map alongside, or undefined off the map. The
 * ship's own tiles lie in the berth box, which is `void` on every map.
 */
export function tileKindAt(berth: BerthedDock, tile: TileCoord): DockTileKind | undefined {
  const { dock } = berth;
  const t = deckToDock(berth, tile);
  if (t.x < 0 || t.y < 0 || t.x >= dock.width || t.y >= dock.height) return undefined;
  const ch = dock.rows[t.y]?.[t.x];
  return ch === undefined ? undefined : dock.legend[ch];
}

/** Is deck-frame tile `tile` cover: a `cover` tile, or under a blocking prop? */
export function isCover(berth: BerthedDock, tile: TileCoord): boolean {
  if (tileKindAt(berth, tile) === "cover") return true;
  const t = deckToDock(berth, tile);
  return berth.dock.props.some(
    (prop) =>
      prop.blocking &&
      t.x >= prop.rect.x &&
      t.y >= prop.rect.y &&
      t.x < prop.rect.x + prop.rect.w &&
      t.y < prop.rect.y + prop.rect.h,
  );
}

/** Every post of `kind` on `dock`, in authored order (tiles in the dock's own frame). */
export function postsOfKind(dock: DockDef, kind: DockPostKind): DockPostDef[] {
  return dock.posts.filter((post) => post.kind === kind);
}

/**
 * The foot of the personnel ramp on the map alongside (deck frame): where the party gathers and
 * where it retreats to. Undefined with no dock alongside, or no ramp landing on it.
 */
export function rampFoot(content: ContentBundle, state: SiteHost): TileCoord | undefined {
  const presence = state.deck.dock;
  const berth = dockAlongside(content, state);
  if (presence === undefined || berth === undefined) return undefined;
  return personnelRampFoot(content, presence.deckId, berth);
}
