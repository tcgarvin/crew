/**
 * Buying from a port market (§buying-parts). The one place money leaves the ship for parts:
 * `buyFromMarket` is the commit point of a `buyParts` task's `buy` step
 * (`systems/work/execute.ts`), after the buyer has walked to a cargo transfer tile while the ship
 * is docked at the port.
 *
 * What a purchase does, in order: the market line loses `count` units, the ship's balance drops
 * by `count × price` (a `purchase` transaction), the units appear on the deck at the buyer's
 * feet (handed over the ramp; SD §14.6 no teleporting, the buyer is standing there), every crew
 * member is told where they are (a `reported` item fact, as the ship-familiarity briefing does),
 * and `partsBought` is emitted. The `partsNeeded` (or `reserveLow`) problems for the item are
 * then settled here too: resolved when the purchase covers one, otherwise its count drops by what
 * was bought and its revision bumps so the `buyParts` task re-derives for the rest.
 *
 * With the port's dock alongside (§dock-market-and-passengers): the counter is the dock's market
 * stall (or, with no stall, the market through its gate) and the units are handed over into the
 * buyer's hands; the buyer carries them aboard and sets them down at the top of the cargo ramp
 * (`setDownBought`), and only then is their `buyParts` task done (the work system keeps a claimed
 * one past its resolved problem). Stock and prices are unchanged.
 */
import { rebuildItemIndexes } from "../../core/caches";
import { allocateId } from "../../core/ids";
import { affordableUnits, effectiveMarket, ensureMarket } from "../../core/markets";
import type { Actor } from "../../core/types/actor";
import type { PhysicalLocation } from "../../core/types/common";
import type { PortDef } from "../../core/types/content";
import type { ItemDefId, ItemId, PortDefId, TransactionId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ProblemOfKind } from "../../core/types/work";
import { resolveProblem } from "../equipment/problems";
import { writeFact } from "../work/facts";

/** Why a purchase cannot happen here, for the digest and the narrator; `undefined` = it can. */
export type MarketBlock = "notDocked" | "notSoldHere" | "cannotAfford";

export function marketBlock(
  state: Pick<ReadonlyWorldState, "markets" | "money" | "travel">,
  content: StepCtx["content"],
  itemDefId: ItemDefId,
): MarketBlock | undefined {
  const travel = state.travel;
  if (travel.stage !== "docked") return "notDocked";
  const line = effectiveMarket(state, content, travel.portId)[itemDefId];
  if (line === undefined || line.count <= 0) return "notSoldHere";
  if (state.money.balance < line.price) return "cannotAfford";
  return undefined;
}

/**
 * §buying-parts: where a buyer is while out through the gate at a port whose market has no stall on
 * the dock: its market store, else its first store.
 */
export function marketStoreLocation(port: PortDef): PhysicalLocation {
  const store = port.externalStores.find((s) => s.kind === "market") ?? port.externalStores[0];
  if (store === undefined) throw new Error(`Port "${port.id}" has no external store`);
  return { kind: "inExternalStore", portId: port.id, storeKey: store.key };
}

/**
 * Where bought units go: `feet` sets them on the deck where the buyer stands (over the
 * ramp); `hands` puts them in the buyer's hands (at the dock's stall or back through the
 * gate) to be carried aboard.
 */
export type Handover = "feet" | "hands";

/** The middle of the tile someone on deck stands on. */
function atFeet(location: Extract<PhysicalLocation, { kind: "onDeck" }>): PhysicalLocation {
  return {
    kind: "onDeck",
    deckId: location.deckId,
    x: Math.floor(location.x) + 0.5,
    y: Math.floor(location.y) + 0.5,
  };
}

function spawnBought(
  ctx: StepCtx,
  buyer: Actor,
  itemDefId: ItemDefId,
  count: number,
  handover: Handover,
): ItemId[] {
  if (buyer.location.kind !== "onDeck") throw new Error("buyFromMarket: buyer is not on deck");
  const def = ctx.defs.item(itemDefId);
  const location: PhysicalLocation =
    handover === "hands" ? { kind: "carriedBy", actorId: buyer.id } : atFeet(buyer.location);
  const ids: ItemId[] = [];
  // One item per unique unit; stackables in stacks of at most `maxStack` (a restock of
  // rations is a hundred units), as the scenario spawns them.
  const chunk = def.stacking === "unique" ? 1 : Math.max(1, def.maxStack);
  for (let left = count; left > 0; left -= chunk) {
    const id = allocateId(ctx.state, "item");
    const item: Item =
      def.stacking === "unique"
        ? { id, defId: def.id, stacking: "unique", condition: 1, location }
        : {
            id,
            defId: def.id,
            stacking: "stack",
            count: Math.min(chunk, left),
            reserved: 0,
            location,
          };
    ctx.state.items[id] = item;
    ids.push(id);
  }
  return ids;
}

/**
 * §buying-parts: the buyer sets down every unit of `itemDefId` they carry where they stand (aboard,
 * at the top of the cargo ramp), and the crew are told, as they are of a purchase. Returns what was
 * set down; empty if they carry none (dropped earlier, or never bought).
 */
export function setDownBought(ctx: StepCtx, buyer: Actor, itemDefId: ItemDefId): ItemId[] {
  const location = buyer.location;
  if (location.kind !== "onDeck") return [];
  const ids: ItemId[] = [];
  for (const item of Object.values(ctx.state.items)) {
    const held = item.location;
    if (held.kind !== "carriedBy" || held.actorId !== buyer.id || item.defId !== itemDefId) {
      continue;
    }
    item.location = atFeet(location);
    ids.push(item.id);
  }
  if (ids.length === 0) return ids;
  ctx.dirty.inventory = true;
  rebuildItemIndexes(ctx.state, ctx.caches.index);
  reportToCrew(ctx, buyer, ids);
  return ids;
}

/** Everyone aboard is told the new stock is at the ramp, as the manifest briefing tells them. */
function reportToCrew(ctx: StepCtx, buyer: Actor, itemIds: readonly ItemId[]): void {
  for (const actor of Object.values(ctx.state.actors)) {
    if (!actor.crew) continue;
    for (const itemId of itemIds) {
      const item = ctx.state.items[itemId];
      if (item === undefined) continue;
      writeFact(
        actor,
        itemId,
        "itemLocation",
        { location: item.location },
        actor.id === buyer.id
          ? { tick: ctx.tick, sourceId: buyer.id, evidence: "direct", certainty: "confirmed" }
          : { tick: ctx.tick, sourceId: buyer.id, evidence: "report", certainty: "reported" },
      );
    }
  }
}

function settlePurchase(
  ctx: StepCtx,
  problem: ProblemOfKind<"partsNeeded" | "reserveLow">,
  bought: number,
): void {
  if (bought >= problem.payload.count) {
    const resolved = resolveProblem(ctx.state, problem.dedupeKey);
    if (resolved !== undefined) ctx.emit(resolved);
    return;
  }
  problem.payload = { ...problem.payload, count: problem.payload.count - bought };
  problem.revision += 1;
}

export interface Purchase {
  readonly count: number;
  readonly cost: number;
  readonly itemIds: readonly ItemId[];
}

/**
 * Buy up to `wanted` of `itemDefId` at `portId` for `buyer`. Returns what was bought, or
 * `undefined` when nothing could be (not docked there, nothing in stock, or no money for even
 * one unit). The caller has already checked the buyer is at the counter (`marketCounter`).
 */
export function buyFromMarket(
  ctx: StepCtx,
  buyer: Actor,
  portId: PortDefId,
  itemDefId: ItemDefId,
  wanted: number,
  handover: Handover = "feet",
): Purchase | undefined {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || travel.portId !== portId) return undefined;
  const count = affordableUnits(ctx.state, ctx.content, portId, itemDefId, wanted);
  if (count <= 0) return undefined;
  const market = ensureMarket(ctx.state, ctx.content, portId);
  const line = market[itemDefId];
  if (line === undefined) return undefined;
  const cost = count * line.price;

  line.count -= count;
  const txId: TransactionId = allocateId(ctx.state, "transaction");
  ctx.state.money.balance -= cost;
  ctx.state.money.transactions[txId] = {
    id: txId,
    tick: ctx.tick,
    amount: -cost,
    reason: "purchase",
  };

  const itemIds = spawnBought(ctx, buyer, itemDefId, count, handover);
  ctx.dirty.inventory = true;
  rebuildItemIndexes(ctx.state, ctx.caches.index);
  reportToCrew(ctx, buyer, itemIds);
  ctx.emit({
    type: "partsBought",
    subjectIds: [buyer.id, ...itemIds],
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId },
    payload: { portId, itemDefId, count, cost },
  });

  for (const problem of Object.values(ctx.state.work.problems)) {
    if (problem.kind !== "partsNeeded" && problem.kind !== "reserveLow") continue;
    if (problem.status !== "open" || problem.payload.itemDefId !== itemDefId) continue;
    settlePurchase(ctx, problem, count);
  }
  return { count, cost, itemIds };
}
