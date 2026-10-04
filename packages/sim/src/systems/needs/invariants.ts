/**
 * Needs invariants for tests (SD §19.4 style). D74: every berth is a bed on the ship's deck: a
 * placement there whose machine carries `bed` and not `medBed`. Keys being actors and no shared
 * beds are content-free and live in `core/invariants.ts` (`berthViolations`).
 */
import { isBerthPlacement } from "../../core/berths";
import type { World } from "../../core/types/kernel";
import { shipDeckId } from "../../core/world";

export function needsViolations(world: Pick<World, "state" | "content">): string[] {
  const { state, content } = world;
  const entries = Object.entries(state.berths);
  if (entries.length === 0) return [];
  const deckId = shipDeckId(state);
  const deck = content.decks[deckId];
  if (deck === undefined) return [`berths: ship deck ${deckId} is not in content`];
  const out: string[] = [];
  for (const [actorId, key] of entries) {
    const placement = deck.machines.find((p) => p.key === key);
    if (placement === undefined) {
      out.push(`berths.${actorId} "${key}" is no placement on ${deckId}`);
    } else if (!isBerthPlacement(content, placement)) {
      out.push(`berths.${actorId} "${key}" is not a bed`);
    }
  }
  return out;
}
