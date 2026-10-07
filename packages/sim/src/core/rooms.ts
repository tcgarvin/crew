/**
 * D94: a room as a sentence names it. Ticker lines, labels and digests say "a scar in the cargo
 * hold" but "a scar in engineering": the deck's compartment carries its own `phrase` where "the"
 * and its lowercased name would read wrong, and every other room takes the article.
 */
import type { CompartmentDef } from "./types/content";

/** "the cargo hold", "the captain's cabin", or the room's own `phrase` ("engineering"). */
export function roomPhrase(def: Pick<CompartmentDef, "name" | "phrase">): string {
  return def.phrase ?? `the ${def.name.toLowerCase()}`;
}
