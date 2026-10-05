/**
 * Where the galley is and what its meals are (D81): the stove, the serving counter, the room a
 * tile is in, the meal items and their quality. Pure reads over state and content, shared by the
 * galley system, its plans and its task derivation.
 *
 * Owner: W1 of ship life slice 3.
 */
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ConfigDef, ContentBundle, DirtTier, MealQuality } from "../../core/types/content";
import type { ActorId, DeckDefId, LocalKey, MachineId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import type { Item, Machine } from "../../core/types/ship";
import { shipDeckId } from "../../core/world";
import { rotateOffset } from "../spatial/geometry";

type KitchenState = Pick<ReadonlyWorldState, "machines" | "deck">;
type KitchenContent = Pick<ContentBundle, "machines" | "decks">;

/** The ship's stove: the first `stove`-tagged machine on the ship's deck, by id. */
export function stoveOf(
  state: KitchenState,
  content: KitchenContent,
): DeepReadonly<Machine> | undefined {
  const deckId = shipDeckId(state);
  return Object.values(state.machines)
    .filter((m) => m.deckId === deckId && content.machines[m.defId]?.tags.includes("stove"))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/**
 * Absolute tiles of a placed machine's interaction positions with `purpose` (origin + rotated
 * offset), in def order; `[]` if the placement cannot be resolved.
 */
export function positionTiles(
  state: Pick<ReadonlyWorldState, "machines">,
  content: KitchenContent,
  machineId: MachineId,
  purpose: "operate" | "repair" | "use",
): TileCoord[] {
  const machine = state.machines[machineId];
  if (machine === undefined) return [];
  const def = content.machines[machine.defId];
  const placement = content.decks[machine.deckId]?.machines.find(
    (p) => p.key === machine.placementKey,
  );
  if (def === undefined || placement === undefined) return [];
  return def.interactionPositions
    .filter((p) => p.purposes.includes(purpose))
    .map((p) => {
      const rotated = rotateOffset(p.offset, placement.rotation);
      return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
    });
}

/** The tiles of the deck's `serving` zones (the counter the cook sets the meal down on). */
export function servingTiles(
  content: Pick<ContentBundle, "decks">,
  deckId: DeckDefId,
): TileCoord[] {
  const deck = content.decks[deckId];
  if (deck === undefined) return [];
  return deck.zones
    .filter((zone) => zone.tags.includes("serving"))
    .flatMap((zone) => zone.tiles.map((t) => ({ x: t.x, y: t.y })));
}

/** The key of the compartment (room) `tile` is in on `deckId`, if it is in one. */
export function roomKeyAt(
  content: Pick<ContentBundle, "decks">,
  deckId: DeckDefId,
  tile: TileCoord,
): LocalKey | undefined {
  const deck = content.decks[deckId];
  const symbol = deck?.tiles[tile.y]?.[tile.x];
  if (deck === undefined || symbol === undefined) return undefined;
  return deck.compartments.find((c) => c.symbol === symbol)?.key;
}

/** The tier dirt last wrote for the room `tile` is in (`clean` for a room with none yet). */
export function roomTierAt(
  state: Pick<ReadonlyWorldState, "dirt">,
  content: Pick<ContentBundle, "decks">,
  deckId: DeckDefId,
  tile: TileCoord,
): DirtTier {
  const key = roomKeyAt(content, deckId, tile);
  return key === undefined ? "clean" : (state.dirt.tiers[key] ?? "clean");
}

/** Is the item a serving of the galley's meal (its def tagged `meal`)? */
export function isMeal(content: Pick<ContentBundle, "items">, item: DeepReadonly<Item>): boolean {
  return content.items[item.defId]?.tags.includes("meal") === true;
}

/** Units in an item (a stack's count, else 1). */
export function unitsOf(item: DeepReadonly<Item>): number {
  return item.stacking === "stack" ? item.count : 1;
}

const QUALITY_STEPS: readonly MealQuality[] = ["poor", "plain", "good"];

/**
 * How good a meal is (call 4): cooking at or above `goodCookingAbove` good, below
 * `poorCookingBelow` poor, else plain; a galley at `dirty` or worse drops it one step.
 */
export function mealQuality(
  cooking: number,
  galleyTier: DirtTier,
  config: Pick<ConfigDef, "galley">,
): MealQuality {
  const { goodCookingAbove, poorCookingBelow } = config.galley;
  const base = cooking >= goodCookingAbove ? 2 : cooking < poorCookingBelow ? 0 : 1;
  const dirty = galleyTier === "dirty" || galleyTier === "filthy";
  return QUALITY_STEPS[Math.max(0, base - (dirty ? 1 : 0))] ?? "poor";
}

/** Within arm's reach: the same tile or one of its eight neighbours. */
export const withinArm = (a: TileCoord, b: TileCoord): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

/** The tile an on-deck location is on. */
export const tileAt = (location: { readonly x: number; readonly y: number }): TileCoord => ({
  x: Math.floor(location.x),
  y: Math.floor(location.y),
});

/** Is `item` lying on deck within arm's reach of `tile`, or carried by `actorId`? */
export function servingWithinReach(
  item: DeepReadonly<Item>,
  deckId: DeckDefId,
  tile: TileCoord,
  actorId: ActorId,
): boolean {
  const location = item.location;
  if (location.kind === "carriedBy") return location.actorId === actorId;
  return (
    location.kind === "onDeck" && location.deckId === deckId && withinArm(tileAt(location), tile)
  );
}
