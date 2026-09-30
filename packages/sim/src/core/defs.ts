/**
 * Definition lookup: the static bundle first, then per-game generated defs in
 * `state.defs.dynamic`. `DefLookup` throws on a miss (a bug once content is validated); the
 * `find*` helpers return `undefined` for validation code that must reject rather than throw.
 */
import type { ContentBundle, CrewDef, ItemDef } from "./types/content";
import type { CrewDefId, ItemDefId } from "./types/ids";
import type { DefLookup, ReadonlyWorldState } from "./types/pipeline";

function required<T>(value: T | undefined, kind: string, id: string): T {
  if (value === undefined) {
    throw new Error(`Unknown ${kind} definition "${id}"`);
  }
  return value;
}

export function findItemDef(
  content: ContentBundle,
  state: ReadonlyWorldState,
  id: ItemDefId,
): ItemDef | undefined {
  return content.items[id] ?? (state.defs.dynamic.items[id] as ItemDef | undefined);
}

export function findCrewDef(
  content: ContentBundle,
  state: ReadonlyWorldState,
  id: CrewDefId,
): CrewDef | undefined {
  return content.crew[id] ?? (state.defs.dynamic.crew[id] as CrewDef | undefined);
}

export function createDefLookup(content: ContentBundle, state: ReadonlyWorldState): DefLookup {
  return {
    deck: (id) => required(content.decks[id], "deck", id),
    machine: (id) => required(content.machines[id], "machine", id),
    item: (id) => required(findItemDef(content, state, id), "item", id),
    crew: (id) => required(findCrewDef(content, state, id), "crew", id),
    trait: (id) => required(content.traits[id], "trait", id),
    port: (id) => required(content.ports[id], "port", id),
  };
}
