/**
 * Phase 2: what a tap on the dock map selects when it hits no person, crate or machine: a post
 * (the inspector names it) or bare dock floor (the inspector describes the place). Coordinates
 * are in the grafted deck frame, so the caller removes the dock's slide first.
 */
import type { BerthedDock } from "@crew/sim";
import type { DeckLayout } from "./deckLayout";
import { isShipTile } from "./dock";
import { dockTileKind } from "./dockShape";

/** How close to a post's tile centre a tap must land to pick the post, tiles. */
export const POST_HIT_RADIUS_TILES = 0.9;

export type DockTarget =
  | { readonly kind: "post"; readonly id: string }
  | { readonly kind: "dock"; readonly id: string };

export function dockTargetAt(
  { dock, shipAt }: BerthedDock,
  layout: Pick<DeckLayout, "width" | "height" | "tiles">,
  deckX: number,
  deckY: number,
): DockTarget | undefined {
  if (isShipTile(layout, deckX, deckY)) return undefined;
  const x = deckX + shipAt.x;
  const y = deckY + shipAt.y;
  let best: DockTarget | undefined;
  let bestDist = POST_HIT_RADIUS_TILES;
  for (const post of dock.posts) {
    const d = Math.hypot(post.tile.x + 0.5 - x, post.tile.y + 0.5 - y);
    if (d < bestDist) {
      bestDist = d;
      best = { kind: "post", id: post.key };
    }
  }
  if (best !== undefined) return best;
  return dockTileKind(dock, x, y) === "floor" ? { kind: "dock", id: dock.id } : undefined;
}
