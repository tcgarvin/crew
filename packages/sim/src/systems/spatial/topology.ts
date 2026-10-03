/**
 * Phase 2 nav refresh: when `dirty.navigation` is set or the deck's geometry revision moved, copy
 * dynamic state (obstructions, open ramps) into the geometry and drop cached paths. When a dock
 * has attached or detached since the cache was built, rebuild the geometry instead (its bounds
 * change). Reservations are keyed by deck coordinates, which the graft never moves, so they stay.
 */
import type { System } from "../../core/types/pipeline";
import { dockGraftCurrent, rebuildGeometries, refreshDynamic } from "./geometry";

export const navRefreshSystem: System = {
  name: "spatial.navRefresh",
  phase: "topology",
  run(ctx) {
    const nav = ctx.caches.nav;
    if (!ctx.dirty.navigation && nav.geometryRevision === ctx.state.deck.geometryRevision) return;
    if (dockGraftCurrent(ctx.caches, ctx.state)) {
      for (const geometry of Object.values(nav.decks)) refreshDynamic(geometry, ctx.state);
      nav.paths.clear();
    } else {
      rebuildGeometries(ctx.caches, ctx.content, ctx.state);
    }
    nav.geometryRevision = ctx.state.deck.geometryRevision;
    ctx.dirty.navigation = false;
  },
};
