/**
 * Derived caches (CONTRACTS rule 3). Nothing here is authoritative; `rebuildCaches` recreates the
 * kernel-owned indexes from state and runs every registered cache builder (W3 fills `nav`).
 */
import type { KernelRegistry } from "./registry";
import type { ContentBundle } from "./types/content";
import type { ActorId, CompartmentId, DeckDefId, ItemId, MachineId } from "./types/ids";
import type { World } from "./types/kernel";
import type { DerivedCaches, IndexCache, NavCache, ReadonlyWorldState } from "./types/pipeline";

/** An unbuilt nav cache (W3 owns it); `geometryRevision` -1 means "never built". */
function emptyNavCache(): NavCache {
  return { geometryRevision: -1, edgeMask: {}, decks: {}, paths: new Map(), reservations: {} };
}

export function emptyCaches(): DerivedCaches {
  return {
    dirty: { navigation: true, power: true, inventory: true },
    nav: emptyNavCache(),
    index: {
      itemsByHolder: {},
      itemsByContainer: {},
      actorsByCompartment: {},
      machinesByCompartment: {},
    },
    diagnostics: { traceEvents: [], plannerTraces: [], lastEvents: [], announcedDecisionId: null },
  };
}

/** Resolve deck tiles to compartment instance IDs via the tile symbol and compartment key. */
function createCompartmentLocator(
  content: ContentBundle,
  state: ReadonlyWorldState,
): (deckId: DeckDefId, x: number, y: number) => CompartmentId | undefined {
  const byDeckAndKey = new Map<string, CompartmentId>();
  for (const compartment of Object.values(state.compartments)) {
    byDeckAndKey.set(`${compartment.deckId}/${compartment.key}`, compartment.id);
  }
  return (deckId, x, y) => {
    const deck = content.decks[deckId];
    const symbol = deck?.tiles[Math.floor(y)]?.[Math.floor(x)];
    if (deck === undefined || symbol === undefined || symbol === " ") return undefined;
    const def = deck.compartments.find((c) => c.symbol === symbol);
    return def === undefined ? undefined : byDeckAndKey.get(`${deckId}/${def.key}`);
  };
}

function push<K extends string, V>(table: Record<K, V[]>, key: K, value: V): void {
  const list = table[key];
  if (list === undefined) {
    table[key] = [value];
  } else {
    list.push(value);
  }
}

/** Items by holder and by container. */
export function rebuildItemIndexes(state: ReadonlyWorldState, index: IndexCache): void {
  const byHolder: Record<ActorId, ItemId[]> = {};
  const byContainer: Record<ItemId, ItemId[]> = {};
  for (const item of Object.values(state.items)) {
    const location = item.location;
    if (location.kind === "carriedBy" || location.kind === "equippedBy") {
      push(byHolder, location.actorId, item.id);
    } else if (location.kind === "inContainer") {
      push(byContainer, location.containerId, item.id);
    }
  }
  index.itemsByHolder = byHolder;
  index.itemsByContainer = byContainer;
}

export function rebuildActorIndex(
  content: ContentBundle,
  state: ReadonlyWorldState,
  index: IndexCache,
): void {
  const locate = createCompartmentLocator(content, state);
  const byCompartment: Record<CompartmentId, ActorId[]> = {};
  for (const actor of Object.values(state.actors)) {
    if (actor.location.kind !== "onDeck") continue;
    const compartmentId = locate(actor.location.deckId, actor.location.x, actor.location.y);
    if (compartmentId !== undefined) push(byCompartment, compartmentId, actor.id);
  }
  index.actorsByCompartment = byCompartment;
}

function rebuildMachineIndex(
  content: ContentBundle,
  state: ReadonlyWorldState,
  index: IndexCache,
): void {
  const locate = createCompartmentLocator(content, state);
  const byCompartment: Record<CompartmentId, MachineId[]> = {};
  for (const machine of Object.values(state.machines)) {
    const placement = content.decks[machine.deckId]?.machines.find(
      (p) => p.key === machine.placementKey,
    );
    if (placement === undefined) continue;
    const compartmentId = locate(machine.deckId, placement.origin.x, placement.origin.y);
    if (compartmentId !== undefined) push(byCompartment, compartmentId, machine.id);
  }
  index.machinesByCompartment = byCompartment;
}

/**
 * Rebuild every derived cache from state + content and set every dirty flag, so systems that
 * consume flags (nav, power, inventory) refresh on their next run. Diagnostics and kernel
 * bookkeeping are left as they are.
 */
export function rebuildCaches(world: World, registry: KernelRegistry): void {
  const { state, content, caches } = world;
  caches.dirty.navigation = true;
  caches.dirty.power = true;
  caches.dirty.inventory = true;
  rebuildItemIndexes(state, caches.index);
  rebuildActorIndex(content, state, caches.index);
  rebuildMachineIndex(content, state, caches.index);
  for (const builder of registry.cacheBuilders()) {
    builder.build(world);
  }
}
