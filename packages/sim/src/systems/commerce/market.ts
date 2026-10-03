/**
 * Buying from a port market (D47). The one place money leaves the ship for parts: `buyFromMarket`
 * is the commit point of a `buyParts` task's `buy` step (`systems/work/execute.ts`), after the
 * buyer has walked to a cargo transfer tile while the ship is docked at the port.
 *
 * What a purchase does, in order: the market line loses `count` units, the ship's balance drops
 * by `count × price` (a `purchase` transaction), the units appear on the deck at the buyer's
 * feet (handed over the ramp; SD §14.6 no teleporting, the buyer is standing there), every crew
 * member is told where they are (a `reported` item fact, as the ship-familiarity briefing does),
 * and `partsBought` is emitted. The `partsNeeded` problem is then settled here too: resolved when
 * the purchase covers it, otherwise its count drops by what was bought and its revision bumps so
 * the `buyParts` task re-derives for the rest.
 */
import { rebuildItemIndexes } from "../../core/caches";
import { allocateId } from "../../core/ids";
import { affordableUnits, effectiveMarket, ensureMarket } from "../../core/markets";
import type { Actor } from "../../core/types/actor";
import type { ItemDefId, ItemId, PortDefId, TransactionId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ProblemOfKind } from "../../core/types/work";
import { resolveProblem } from "../equipment/problems";
import { writeFact } from "../work/facts";

/** Moved to `core/markets` so travel can read it without a travel/commerce import cycle. */
export { affordableUnits } from "../../core/markets";

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

function spawnBought(ctx: StepCtx, buyer: Actor, itemDefId: ItemDefId, count: number): ItemId[] {
  if (buyer.location.kind !== "onDeck") throw new Error("buyFromMarket: buyer is not on deck");
  const def = ctx.defs.item(itemDefId);
  const { deckId } = buyer.location;
  const x = Math.floor(buyer.location.x) + 0.5;
  const y = Math.floor(buyer.location.y) + 0.5;
  const ids: ItemId[] = [];
  const units = def.stacking === "unique" ? count : 1;
  for (let i = 0; i < units; i++) {
    const id = allocateId(ctx.state, "item");
    const item: Item =
      def.stacking === "unique"
        ? {
            id,
            defId: def.id,
            stacking: "unique",
            condition: 1,
            location: { kind: "onDeck", deckId, x, y },
          }
        : {
            id,
            defId: def.id,
            stacking: "stack",
            count,
            reserved: 0,
            location: { kind: "onDeck", deckId, x, y },
          };
    ctx.state.items[id] = item;
    ids.push(id);
  }
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

function settlePartsNeeded(
  ctx: StepCtx,
  problem: ProblemOfKind<"partsNeeded">,
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
 * one unit). The caller has already checked the buyer stands on a cargo transfer tile.
 */
export function buyFromMarket(
  ctx: StepCtx,
  buyer: Actor,
  portId: PortDefId,
  itemDefId: ItemDefId,
  wanted: number,
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

  const itemIds = spawnBought(ctx, buyer, itemDefId, count);
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
    if (problem.kind !== "partsNeeded" || problem.status !== "open") continue;
    if (problem.payload.itemDefId !== itemDefId) continue;
    settlePartsNeeded(ctx, problem, count);
  }
  return { count, cost, itemIds };
}
