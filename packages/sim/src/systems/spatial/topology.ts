/**
 * Phase 2 nav refresh: when `dirty.navigation` is set or the deck's geometry revision moved, copy
 * dynamic obstructions into the geometry and drop cached paths.
 */
import type { System } from "../../core/types/pipeline";
import { refreshObstructions } from "./geometry";

export const navRefreshSystem: System = {
  name: "spatial.navRefresh",
  phase: "topology",
  run(ctx) {
    const nav = ctx.caches.nav;
    if (!ctx.dirty.navigation && nav.geometryRevision === ctx.state.deck.geometryRevision) return;
    for (const geometry of Object.values(nav.decks)) refreshObstructions(geometry, ctx.state);
    nav.paths.clear();
    nav.geometryRevision = ctx.state.deck.geometryRevision;
    ctx.dirty.navigation = false;
  },
};
