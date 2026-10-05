/**
 * Dirt invariants that need content (D82): each deck's dirt row is `width × height` long, and
 * every stored tier names a room of a deck in state. `core/invariants.ts` checks the cells' range
 * without content.
 *
 * Owner: W2 of ship life slice 3.
 */
import type { World } from "../../core/types/kernel";

export function dirtViolations(world: Pick<World, "state" | "content">): string[] {
  const { state, content } = world;
  const out: string[] = [];
  for (const deckId of Object.keys(state.deck.tiles)) {
    const deck = content.decks[deckId as keyof typeof content.decks];
    const cells = state.dirt.cells[deckId as keyof typeof state.dirt.cells];
    if (deck === undefined || cells === undefined) continue;
    if (cells.length !== deck.width * deck.height) {
      out.push(
        `dirt.cells.${deckId} has ${cells.length} cells for a ${deck.width}×${deck.height} deck`,
      );
    }
  }
  const rooms = new Set(
    Object.keys(state.deck.tiles).flatMap(
      (deckId) =>
        content.decks[deckId as keyof typeof content.decks]?.compartments.map((c) => c.key) ?? [],
    ),
  );
  for (const key of Object.keys(state.dirt.tiers)) {
    if (!rooms.has(key)) out.push(`dirt.tiers.${key} is no room of the ship's deck`);
  }
  return out;
}
