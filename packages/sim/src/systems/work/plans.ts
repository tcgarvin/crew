/**
 * Turning an intent into a bounded plan (SD §14.3). The plan is built from the actor's *beliefs*
 * about where things are (item location facts) plus static geometry; execution then checks each
 * step against truth and fails with a structured reason when belief and truth disagree.
 *
 * Generic shape: acquire(item) = moveTo(believed spot) + pickUp → moveTo(target) → work/hold →
 * commit (consume, putDown).
 */
import { configTicks, dayTicks } from "../../core/clock";
import { marketCounter } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type { ItemId, MachineId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type {
  ActivityPlan,
  ActivityStep,
  BlockageReason,
  Intent,
  StepTarget,
  Task,
} from "../../core/types/work";
import { lookForWorkPlan, meetingPlan } from "./shore";

export type PlanResult =
  | { readonly ok: true; readonly plan: ActivityPlan }
  | { readonly ok: false; readonly reason: BlockageReason };

type Purpose = "operate" | "repair" | "use";

const planOf = (steps: ActivityStep[]): PlanResult => ({ ok: true, plan: { steps, stepIndex: 0 } });
const blocked = (reason: BlockageReason): PlanResult => ({ ok: false, reason });

export const tileOf = (location: { x: number; y: number }): TileCoord => ({
  x: Math.floor(location.x),
  y: Math.floor(location.y),
});

/** Within arm's reach: the same tile or one of its eight neighbours. */
export const near = (a: TileCoord, b: TileCoord): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

/** The actor's belief about where an item is, ignoring beliefs marked absent. */
export function believedLocation(actor: Actor, itemId: ItemId): PhysicalLocation | undefined {
  const fact = actor.knowledge[`${itemId}/itemLocation`];
  if (fact?.factType !== "itemLocation" || fact.value.absent === true) return undefined;
  return fact.value.location;
}

export function isCarriedBy(ctx: Pick<StepCtx, "state">, itemId: ItemId, actorId: Actor["id"]) {
  const location = ctx.state.items[itemId]?.location;
  return location?.kind === "carriedBy" && location.actorId === actorId;
}

/** Items the actor is carrying (truth: they always know what is in their hands). */
export function carriedItems(ctx: Pick<StepCtx, "state">, actorId: Actor["id"]) {
  return Object.values(ctx.state.items).filter(
    (item) => item.location.kind === "carriedBy" && item.location.actorId === actorId,
  );
}

function actorDeck(actor: Actor) {
  return actor.location.kind === "onDeck" ? actor.location.deckId : undefined;
}

/** Floor tile to stand on to take an item from `location`, if it is reachable from the deck. */
function pickupTile(ctx: StepCtx, actor: Actor, location: PhysicalLocation): TileCoord | undefined {
  if (location.kind === "onDeck") return tileOf(location);
  if (location.kind === "inExternalStore") {
    const deckId = actorDeck(actor);
    const deck = deckId === undefined ? undefined : ctx.content.decks[deckId];
    return deck?.docking.cargoTransferTiles[0];
  }
  return undefined;
}

function acquireSteps(
  ctx: StepCtx,
  actor: Actor,
  itemId: ItemId,
  split: boolean,
): ActivityStep[] | BlockageReason {
  if (isCarriedBy(ctx, itemId, actor.id)) return [];
  const location = believedLocation(actor, itemId);
  const tile = location === undefined ? undefined : pickupTile(ctx, actor, location);
  if (tile === undefined) return "inaccessibleSupply";
  return [
    { kind: "moveTo", target: { x: tile.x, y: tile.y }, requested: false },
    { kind: "pickUp", itemId, split },
  ];
}

/** A machine interaction position, preferring `purpose`. */
export function interactionTarget(
  ctx: StepCtx,
  actor: Actor,
  machineId: MachineId,
  purpose: Purpose,
): StepTarget | undefined {
  const deckId = actorDeck(actor);
  const geometry = deckId === undefined ? undefined : ctx.caches.nav.decks[deckId];
  const positions = geometry?.interactionPositions.filter((p) => p.machineId === machineId) ?? [];
  const position = positions.find((p) => p.purposes.includes(purpose)) ?? positions[0];
  return position === undefined ? undefined : { machineId, positionKey: position.key };
}

function distance(a: TileCoord, b: TileCoord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Known, not-absent items matching `predicate`, nearest first by believed tile. */
function knownItemsNearest(
  ctx: StepCtx,
  actor: Actor,
  predicate: (defId: ItemId) => boolean,
): ItemId[] {
  const here = actor.location.kind === "onDeck" ? tileOf(actor.location) : { x: 0, y: 0 };
  const candidates: { itemId: ItemId; d: number }[] = [];
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation" || fact.value.absent === true) continue;
    const itemId = fact.subjectId as ItemId;
    if (!predicate(itemId)) continue;
    const tile = pickupTile(ctx, actor, fact.value.location);
    if (tile === undefined) continue;
    candidates.push({ itemId, d: distance(here, tile) });
  }
  candidates.sort((a, b) => a.d - b.d || (a.itemId < b.itemId ? -1 : 1));
  return candidates.map((c) => c.itemId);
}

/** Steps to get the task's tools and consumables into the actor's hands. */
function supplySteps(ctx: StepCtx, actor: Actor, task: Task): ActivityStep[] | BlockageReason {
  const steps: ActivityStep[] = [];
  const carried = carriedItems(ctx, actor.id);
  const defOf = (itemId: ItemId) => {
    const item = ctx.state.items[itemId];
    return item === undefined ? undefined : ctx.content.items[item.defId];
  };
  const planned = new Set<ItemId>();
  for (const kind of task.requiredTools) {
    const inHand = carried.some((item) => ctx.content.items[item.defId]?.toolKinds.includes(kind));
    if (inHand) continue;
    const [toolId] = knownItemsNearest(
      ctx,
      actor,
      (id) => !planned.has(id) && (defOf(id)?.toolKinds.includes(kind) ?? false),
    );
    if (toolId === undefined) return "missingTool";
    const acquire = acquireSteps(ctx, actor, toolId, false);
    if (typeof acquire === "string") return "missingTool";
    planned.add(toolId);
    steps.push(...acquire);
  }
  for (const need of task.consumables) {
    const have = carried
      .filter((item) => item.defId === need.itemDefId)
      .reduce((sum, item) => sum + (item.stacking === "stack" ? item.count : 1), 0);
    if (have >= need.count) continue;
    const [stockId] = knownItemsNearest(
      ctx,
      actor,
      (id) => !planned.has(id) && ctx.state.items[id]?.defId === need.itemDefId,
    );
    if (stockId === undefined) return "inaccessibleSupply";
    const acquire = acquireSteps(ctx, actor, stockId, false);
    if (typeof acquire === "string") return acquire;
    planned.add(stockId);
    steps.push(...acquire);
  }
  return steps;
}

function haulPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "item") return blocked("unreachableTarget");
  const itemId = task.target.itemId;
  const acquire = acquireSteps(ctx, actor, itemId, false);
  if (typeof acquire === "string") return blocked(acquire);
  let destination = task.interactionTiles[0];
  if (destination === undefined) {
    const deckId = actorDeck(actor);
    const deck = deckId === undefined ? undefined : ctx.content.decks[deckId];
    const completion = task.completion;
    destination =
      completion.kind === "itemInZone"
        ? deck?.zones.find((z) => z.key === completion.zoneKey)?.tiles[0]
        : deck?.docking.cargoTransferTiles[0];
  }
  if (destination === undefined) return blocked("unreachableTarget");
  return planOf([
    ...acquire,
    { kind: "moveTo", target: { x: destination.x, y: destination.y }, requested: false },
    { kind: "putDown", itemId },
  ]);
}

function machineTaskPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "machine") return blocked("unreachableTarget");
  const machineId = task.target.machineId;
  if (task.type === "staffStation") {
    const target = interactionTarget(ctx, actor, machineId, "operate");
    if (target === undefined) return blocked("unreachableTarget");
    return planOf([
      { kind: "moveTo", target, requested: false },
      { kind: "hold", hold: "staff", sinceTick: ctx.tick },
    ]);
  }
  const supplies = supplySteps(ctx, actor, task);
  if (typeof supplies === "string") return blocked(supplies);
  const target = interactionTarget(ctx, actor, machineId, "repair");
  if (target === undefined) return blocked("unreachableTarget");
  return planOf([
    ...supplies,
    { kind: "moveTo", target, requested: false },
    { kind: "work", stage: "recipe", ticksDone: 0, ticksNeeded: 0 },
  ]);
}

/**
 * D47: walk to a cargo transfer tile, spend `commerce.market.buySeconds` at the counter, then the
 * `buy` commit step hands the units over the ramp. Only derived while docked at the market's port.
 *
 * D63, with the port's dock alongside: walk to its market stall, spend the time at the counter,
 * take the units in hand, and carry them aboard to the top of the cargo ramp (a cargo transfer
 * tile, where D47 always set them down). A dock with no stall has its market through the gate:
 * walk to the gate, go out (`throughGate`, off ship for the same time), come back with the units
 * and carry them aboard the same way.
 */
function buyPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  const ref = task.progressRef;
  if (ref.kind !== "market") return blocked("unreachableTarget");
  const deckId = actorDeck(actor);
  const deck = deckId === undefined ? undefined : ctx.content.decks[deckId];
  const counterTicks = configTicks(ctx.config, ctx.config.commerce.market.buySeconds);
  const counter = marketCounter(ctx.content, ctx.state, ref.portId);
  const aboard = deck?.docking.cargoTransferTiles[0];
  const purchase = { portId: ref.portId, itemDefId: ref.itemDefId, count: ref.count };
  if (counter.kind === "transferTile") {
    const tile = task.interactionTiles[0] ?? aboard;
    if (tile === undefined) return blocked("unreachableTarget");
    return planOf([
      { kind: "moveTo", target: { x: tile.x, y: tile.y }, requested: false },
      { kind: "work", stage: "buy", ticksDone: 0, ticksNeeded: counterTicks },
      { kind: "buy", ...purchase },
    ]);
  }
  if (aboard === undefined) return blocked("unreachableTarget");
  const atCounter: ActivityStep =
    counter.kind === "stall"
      ? { kind: "work", stage: "buy", ticksDone: 0, ticksNeeded: counterTicks }
      : {
          kind: "throughGate",
          portId: ref.portId,
          gate: { x: counter.tile.x, y: counter.tile.y },
          ticksDone: 0,
          ticksNeeded: counterTicks,
        };
  return planOf([
    { kind: "moveTo", target: { x: counter.tile.x, y: counter.tile.y }, requested: false },
    atCounter,
    { kind: "buy", ...purchase, intoHands: true },
    { kind: "moveTo", target: { x: aboard.x, y: aboard.y }, requested: false },
    { kind: "stowBought", itemDefId: ref.itemDefId },
  ]);
}

export function buildTaskPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.type === "haul") return haulPlan(ctx, actor, task);
  if (task.type === "buyParts") return buyPlan(ctx, actor, task);
  return machineTaskPlan(ctx, actor, task);
}

/** Eat: get one unit (unless one is in hand), optionally carry it to `table`, eat, consume. */
function eatPlan(
  ctx: StepCtx,
  actor: Actor,
  itemId: ItemId | undefined,
  table: TileCoord | undefined,
): PlanResult {
  const mealTicks = dayTicks(ctx.config, ctx.config.needs.mealDays);
  const meal: ActivityStep[] = [
    ...(table === undefined
      ? []
      : [{ kind: "moveTo", target: { x: table.x, y: table.y }, requested: false } as const]),
    { kind: "work", stage: "eat", ticksDone: 0, ticksNeeded: mealTicks },
  ];
  const inHand = carriedItems(ctx, actor.id).find((item) =>
    ctx.content.items[item.defId]?.tags.includes("food"),
  );
  if (inHand !== undefined) return planOf([...meal, { kind: "consume", itemId: inHand.id }]);
  if (itemId === undefined) return blocked("inaccessibleSupply");
  const acquire = acquireSteps(ctx, actor, itemId, true);
  if (typeof acquire === "string") return blocked(acquire);
  return planOf([...acquire, ...meal, { kind: "consume", itemId }]);
}

/** D74: is this bed someone else's berth? Nobody lies down in another's bed. */
function berthOfAnother(ctx: StepCtx, actor: Actor, bed: MachineId): boolean {
  const key = ctx.state.machines[bed]?.placementKey;
  if (key === undefined) return false;
  return Object.entries(ctx.state.berths).some(([id, held]) => held === key && id !== actor.id);
}

export function buildPersonalPlan(
  ctx: StepCtx,
  actor: Actor,
  intent: Extract<Intent, { kind: "personal" }>,
): PlanResult {
  switch (intent.activity) {
    case "eat":
      return eatPlan(ctx, actor, intent.itemId, intent.tile);
    case "sleep": {
      const bed = intent.targetId as MachineId | undefined;
      if (bed !== undefined && berthOfAnother(ctx, actor, bed)) return blocked("occupiedPosition");
      const target = bed === undefined ? undefined : interactionTarget(ctx, actor, bed, "use");
      if (target === undefined) return blocked("unreachableTarget");
      return planOf([
        { kind: "moveTo", target, requested: false },
        { kind: "hold", hold: "sleep", sinceTick: ctx.tick },
      ]);
    }
    case "lookForWork":
      return lookForWorkPlan(ctx, actor);
    case "meetSpeaker":
      return meetingPlan(ctx, intent.decisionId);
    case "rest":
    case "socialize":
    case "wander":
    case "comeAboard": {
      const tile = intent.tile;
      const steps: ActivityStep[] =
        tile === undefined
          ? []
          : [{ kind: "moveTo", target: { x: tile.x, y: tile.y }, requested: false }];
      if (intent.activity === "rest" || intent.activity === "socialize") {
        steps.push({ kind: "hold", hold: intent.activity, sinceTick: ctx.tick });
      }
      return steps.length === 0 ? blocked("unreachableTarget") : planOf(steps);
    }
  }
}
