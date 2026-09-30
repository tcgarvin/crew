/**
 * Temporary "make the dots move" planner stand-in (Integration 1, task item 3). The real planner
 * (W4a) is not registered yet, so crew spawn `idle` and never do anything. This system picks a
 * random walkable tile in a different compartment for any available, stationary crew actor and
 * calls spatial's `requestMove` directly — it never touches `actor.activity`, because
 * `actionLabel()` (`packages/sim/src/core/render.ts`) already reads "walking" for an `idle`
 * activity whose `movement.kind === "moving"`.
 *
 * Registered only in this worker (`sim.worker.ts`), not in `@crew/sim` — it is not part of the
 * kernel, just a host-side stopgap.
 *
 * TODO(W4a): remove when the planner lands.
 */
import type { ActorId, DeckDefId, DeckGeometry, System, TileCoord } from "@crew/sim";
import { compartmentAt, deckGeometry, isWalkable, requestMove } from "@crew/sim";

export const DEV_WANDER = true;

function wanderCandidates(geometry: DeckGeometry, fromCompartmentIndex: number): TileCoord[] {
  const candidates: TileCoord[] = [];
  for (let y = 0; y < geometry.height; y++) {
    for (let x = 0; x < geometry.width; x++) {
      const index = y * geometry.width + x;
      const compartmentIndex = geometry.compartment[index] ?? -1;
      if (compartmentIndex < 0 || compartmentIndex === fromCompartmentIndex) continue;
      if (!isWalkable(geometry, x, y)) continue;
      candidates.push({ x, y });
    }
  }
  return candidates;
}

/** `every: 20` (~1s at the default 20 Hz tick rate): cheap enough to scan the whole deck. */
export const devWanderSystem: System = {
  name: "dev.wander",
  phase: "planning",
  every: 20,
  run(ctx) {
    for (const actor of Object.values(ctx.state.actors)) {
      if (!actor.crew) continue;
      if (actor.availability !== "available") continue;
      if (actor.movement.kind !== "stationary") continue;
      if (actor.location.kind !== "onDeck") continue;
      const deckId = actor.location.deckId as DeckDefId;
      const geometry = deckGeometry(ctx.caches, deckId);
      if (geometry === undefined) continue;
      const here = compartmentAt(geometry, actor.location.x, actor.location.y);
      const fromCompartmentIndex =
        here === undefined ? -1 : geometry.compartmentIds.findIndex((id) => id === here);
      const candidates = wanderCandidates(geometry, fromCompartmentIndex);
      if (candidates.length === 0) continue;
      const target = candidates[ctx.rng.int("social", 0, candidates.length - 1)];
      if (target === undefined) continue;
      requestMove(ctx.state, actor.id as ActorId, target, ctx.caches, ctx.config);
    }
  },
};
