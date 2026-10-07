/**
 * Field invariants for tests (SD §19.4 style), the ones that need content (`core/invariants.ts`
 * holds the hull's arithmetic): every scar lies on the ship deck's hull footprint; an active
 * field lies within its leg's transit, short of the route's end; a scheduled field is not
 * overdue in transit (it enters the tick it falls due); and no alert stands down while a field
 * is active. Pure over state and content.
 */
import { inHullFootprint } from "../../core/hull";
import type { World } from "../../core/types/kernel";
import { shipDeckId } from "../../core/world";

export function fieldViolations(world: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const { state, content } = world;
  const deckId = shipDeckId(state);
  const deck = content.decks[deckId];
  if (deck === undefined) return [`no deck def ${deckId} for the hull`];
  for (const scar of state.hull.scars) {
    if (!inHullFootprint(deck, scar.tile.x, scar.tile.y)) {
      out.push(`scar ${scar.id} at (${scar.tile.x}, ${scar.tile.y}) is off the hull of ${deckId}`);
    }
  }
  const field = state.field;
  const travel = state.travel;
  if (field?.phase.kind === "active") {
    if (travel.stage !== "transit") {
      out.push(`field ${field.id} is active in stage ${travel.stage}`);
    } else if (field.phase.endsAtProgress > travel.routeDistance) {
      out.push(`field ${field.id} ends past the route (${field.phase.endsAtProgress})`);
    }
  }
  if (
    field?.phase.kind === "scheduled" &&
    travel.stage === "transit" &&
    field.startsAtTick < state.tick
  ) {
    out.push(`field ${field.id} is overdue in transit (start ${field.startsAtTick})`);
  }
  if (state.alert?.clearsAtTick !== undefined && field?.phase.kind === "active") {
    out.push(`the alert is standing down while field ${field.id} is active`);
  }
  return out;
}
