/**
 * D65: hauling with the hand truck. A crew member starting a haul who knows where a free hand
 * truck is, and knows of other open hauls the same way (loading with loading, unloading with
 * unloading, to the same place), fetches the truck, loads up to its `capacityUnits` of crates onto
 * it, pushes it to their destinations, sets each crate down there and parks the truck aboard.
 * One activity holds every claim: the planner's chosen task is the activity's own (the lead,
 * set down last) and the others are `Activity.haul.legs`.
 *
 * - Planning reads the actor's beliefs (where the truck and the crates are), the public claim
 *   table and the activities that name a truck (`truckInUse`: using the truck is that record, so
 *   two people never plan with it). Without a known free truck, or with no second crate to move,
 *   the haul is one crate in the hands, as before.
 * - A crate set down off the truck settles its leg at once: completed when its custody predicate
 *   holds, else released. The lead settles when the plan ends, after the truck is parked, so the
 *   cargo work (and with it departure) waits for the truck to come back aboard.
 * - Stopped early (interrupted, failed, incapacitated, called aboard), the actor sets the truck
 *   and everything on it down where they stand (`dropTruckLoad`); no crate is ever left on a
 *   truck nobody is pushing. Each leg whose crate already made it is completed, the rest released.
 * - A truck that is not where the actor thought turns the trip into a one-crate haul of the lead
 *   (`singleHaulFallback`); a leg's crate that is not where they thought drops that leg.
 */
import { isDockPoint } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { TaskReleaseReason } from "../../core/types/events";
import type { ItemId, TaskId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ActivityPlan, ActivityStep, HaulBatch, HaulLeg, Task } from "../../core/types/work";
import { backoffRef, isBackingOff } from "./activity";
import { completeTask, isCompletionMet, releaseActorClaim } from "./claims";
import { isTerminal } from "./derivation";
import { directSight, writeFact } from "./facts";
import { believedLocation, isCarriedBy, tileOf } from "./plans";

type TaskActivity = Extract<Actor["activity"], { kind: "task" }>;

/** Units of freight an item carries as a hand truck; 0 for anything that is not one. */
export function truckCapacity(ctx: Pick<StepCtx, "content">, item: Item | undefined): number {
  if (item === undefined) return 0;
  const def = ctx.content.items[item.defId];
  if (def === undefined || !def.toolKinds.includes("handTruck")) return 0;
  return def.capacityUnits ?? 0;
}

const units = (item: Item): number => (item.stacking === "stack" ? item.count : 1);

const near = (a: TileCoord, b: TileCoord): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

const sameTile = (a: TileCoord, b: TileCoord): boolean => a.x === b.x && a.y === b.y;

const manhattan = (a: TileCoord, b: TileCoord): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** The actor whose activity is a trip with `truckId`, if any: the truck's one user. */
export function truckUser(state: ReadonlyWorldState, truckId: ItemId): Actor["id"] | undefined {
  for (const actor of Object.values(state.actors)) {
    const activity = actor.activity;
    if (activity.kind === "task" && activity.haul?.truckId === truckId) return actor.id;
  }
  return undefined;
}

/** Every task a haul activity holds a claim on: its own, then its legs. */
export function heldTasks(activity: TaskActivity): HaulLeg[] {
  return [{ taskId: activity.taskId, claimId: activity.claimId }, ...(activity.haul?.legs ?? [])];
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

/** A free hand truck the actor knows of: in their hands, or believed lying on deck. */
interface KnownTruck {
  readonly truckId: ItemId;
  readonly capacity: number;
  /** Where to pick it up; undefined when already in hand. */
  readonly tile?: TileCoord;
}

function findTruck(ctx: StepCtx, actor: Actor, here: TileCoord): KnownTruck | undefined {
  let best: { truck: KnownTruck; d: number } | undefined;
  for (const item of Object.values(ctx.state.items)) {
    const capacity = truckCapacity(ctx, item);
    if (capacity < 2) continue;
    const user = truckUser(ctx.state, item.id);
    if (user !== undefined && user !== actor.id) continue;
    if (isCarriedBy(ctx, item.id, actor.id)) return { truckId: item.id, capacity };
    const believed = believedLocation(actor, item.id);
    if (believed?.kind !== "onDeck") continue;
    const tile = tileOf(believed);
    const d = manhattan(here, tile);
    if (best === undefined || d < best.d || (d === best.d && item.id < best.truck.truckId)) {
      best = { truck: { truckId: item.id, capacity, tile }, d };
    }
  }
  return best?.truck;
}

/** Where a haul sets its crate down: its first interaction tile (as `haulPlan` walks to). */
function destinationOf(ctx: StepCtx, actor: Actor, task: Task): TileCoord | undefined {
  const first = task.interactionTiles[0];
  if (first !== undefined) return first;
  const completion = task.completion;
  if (completion.kind !== "itemInZone" || actor.location.kind !== "onDeck") return undefined;
  const deck = ctx.content.decks[actor.location.deckId];
  return deck?.zones.find((z) => z.key === completion.zoneKey)?.tiles[0];
}

/** The two hauls deliver to the same kind of place: the same zone, or the same dock area. */
function sameDelivery(a: Task, b: Task): boolean {
  const x = a.completion;
  const y = b.completion;
  if (x.kind === "itemInZone" && y.kind === "itemInZone") return x.zoneKey === y.zoneKey;
  if (x.kind === "itemInDockArea" && y.kind === "itemInDockArea") {
    return x.dockId === y.dockId && x.area === y.area;
  }
  return false;
}

/** A haul whose crate the actor believes lies on deck and whose drop is a deck tile. */
interface Haul {
  readonly task: Task;
  readonly item: Item;
  readonly from: TileCoord;
  readonly to: TileCoord;
}

function asHaul(ctx: StepCtx, actor: Actor, task: Task): Haul | undefined {
  if (task.type !== "haul" || task.target.kind !== "item") return undefined;
  const completion = task.completion.kind;
  if (completion !== "itemInZone" && completion !== "itemInDockArea") return undefined;
  const item = ctx.state.items[task.target.itemId];
  const believed = believedLocation(actor, task.target.itemId);
  const to = destinationOf(ctx, actor, task);
  if (item === undefined || believed?.kind !== "onDeck" || to === undefined) return undefined;
  return { task, item, from: tileOf(believed), to };
}

/** Could this actor add `task` to a trip led by `lead` (open, free, known, same way)? */
function joinable(ctx: StepCtx, actor: Actor, lead: Task, task: Task): boolean {
  if (task.id === lead.id || isTerminal(task) || task.claimState.kind !== "unclaimed") return false;
  if (task.type !== "haul" || task.derivationKey !== lead.derivationKey) return false;
  if (!sameDelivery(lead, task)) return false;
  if (task.blockage !== undefined && ctx.tick < task.blockage.retryAfterTick) return false;
  if (isBackingOff(actor.workBackoff, backoffRef.task(task.id), ctx.tick)) return false;
  const problem = ctx.state.work.problems[task.problemId];
  if (problem?.status !== "open") return false;
  return problem.visibility === "public" || actor.knowledge[`${problem.id}/problem`] !== undefined;
}

/** Visit `hauls` greedily nearest-first from `start` by `key`'s tile. */
function nearestChain(hauls: readonly Haul[], start: TileCoord, key: "from" | "to"): Haul[] {
  const left = [...hauls];
  const out: Haul[] = [];
  let at = start;
  while (left.length > 0) {
    let bestIndex = 0;
    for (let i = 1; i < left.length; i++) {
      const a = left[i] as Haul;
      const b = left[bestIndex] as Haul;
      const da = manhattan(at, a[key]);
      const db = manhattan(at, b[key]);
      if (da < db || (da === db && a.task.id < b.task.id)) bestIndex = i;
    }
    const [next] = left.splice(bestIndex, 1) as [Haul];
    out.push(next);
    at = next[key];
  }
  return out;
}

export interface TruckPlan {
  readonly plan: ActivityPlan;
  readonly truckId: ItemId;
  /** The other tasks the trip moves, to be claimed with the lead. */
  readonly legs: readonly Task[];
}

/**
 * Plan `lead` as a hand-truck trip, or undefined to haul it by hand: no free truck known, the
 * lead is not a deck-to-deck haul, or there is no second crate to take (unless the truck is
 * already in hand).
 */
export function buildTruckPlan(ctx: StepCtx, actor: Actor, lead: Task): TruckPlan | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const here = tileOf(actor.location);
  const leadHaul = asHaul(ctx, actor, lead);
  if (leadHaul === undefined) return undefined;
  const truck = findTruck(ctx, actor, here);
  if (truck === undefined) return undefined;
  let room = truck.capacity - units(leadHaul.item);
  if (room < 0) return undefined;
  const others: Haul[] = [];
  const candidates: Haul[] = [];
  for (const task of Object.values(ctx.state.work.tasks)) {
    if (!joinable(ctx, actor, lead, task)) continue;
    const haul = asHaul(ctx, actor, task);
    if (haul !== undefined) candidates.push(haul);
  }
  for (const haul of nearestChain(candidates, leadHaul.from, "from")) {
    const size = units(haul.item);
    if (size > room) continue;
    others.push(haul);
    room -= size;
  }
  if (others.length === 0 && truck.tile !== undefined) return undefined;

  const steps: ActivityStep[] = [];
  let at = here;
  const walkTo = (tile: TileCoord, reach: boolean) => {
    if (reach ? near(at, tile) : sameTile(at, tile)) return;
    steps.push({ kind: "moveTo", target: { x: tile.x, y: tile.y }, requested: false });
    at = tile;
  };
  const truckId = truck.truckId;
  if (truck.tile !== undefined) {
    walkTo(truck.tile, true);
    steps.push({ kind: "pickUp", itemId: truckId, split: false });
  }
  const pickups = [leadHaul, ...nearestChain(others, leadHaul.from, "from")];
  for (const haul of pickups) {
    walkTo(haul.from, true);
    steps.push({ kind: "loadTruck", itemId: haul.item.id, truckId });
  }
  const drops = [...nearestChain(others, at, "to"), leadHaul];
  for (const haul of drops) {
    walkTo(haul.to, false);
    steps.push({ kind: "unloadTruck", itemId: haul.item.id, truckId });
  }
  if (isDockPoint(ctx.content, ctx.state, at.x + 0.5, at.y + 0.5)) {
    const deck = ctx.content.decks[actor.location.deckId];
    const aboard = deck?.docking.cargoTransferTiles[0];
    if (aboard === undefined) return undefined;
    walkTo(aboard, false);
  }
  steps.push({ kind: "parkTruck", truckId });
  return { plan: { steps, stepIndex: 0 }, truckId, legs: others.map((h) => h.task) };
}

// ---------------------------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------------------------

function seeWhere(ctx: StepCtx, actor: Actor, item: Item): void {
  writeFact(
    actor,
    item.id,
    "itemLocation",
    { location: item.location },
    directSight(actor, ctx.tick),
  );
}

/** Settle one held task the trip is letting go of: completed if its crate made it, else released. */
export function settleHeld(
  ctx: StepCtx,
  actor: Actor,
  taskId: TaskId,
  reason: TaskReleaseReason,
): void {
  const task = ctx.state.work.tasks[taskId];
  if (task === undefined || isTerminal(task)) return;
  if (isCompletionMet(ctx.state, ctx.content, task)) completeTask(ctx, task);
  else releaseActorClaim(ctx, actor.id, task, reason);
}

/** Remove the leg moving `itemId` from the batch, settling its task. Returns whether one was. */
export function dropLeg(
  ctx: StepCtx,
  actor: Actor,
  batch: HaulBatch,
  itemId: ItemId,
  reason: TaskReleaseReason,
): boolean {
  const index = batch.legs.findIndex((leg) => {
    const target = ctx.state.work.tasks[leg.taskId]?.target;
    return target?.kind === "item" && target.itemId === itemId;
  });
  const leg = batch.legs[index];
  if (leg === undefined) return false;
  batch.legs.splice(index, 1);
  settleHeld(ctx, actor, leg.taskId, reason);
  return true;
}

/** Is `itemId` on the truck `truckId`? */
export function onTruck(state: ReadonlyWorldState, itemId: ItemId, truckId: ItemId): boolean {
  const location = state.items[itemId]?.location;
  return location?.kind === "inContainer" && location.containerId === truckId;
}

/**
 * The actor stops pushing the truck: it and every crate on it are set down where they stand
 * (SD §14.6: no teleporting). Returns whether anything was set down.
 */
export function dropTruckLoad(ctx: StepCtx, actor: Actor, truckId: ItemId): boolean {
  const location = actor.location;
  const truck = ctx.state.items[truckId];
  if (truck === undefined || location.kind !== "onDeck") return false;
  const spot = { kind: "onDeck", deckId: location.deckId, x: location.x, y: location.y } as const;
  let moved = false;
  for (const item of Object.values(ctx.state.items)) {
    if (!onTruck(ctx.state, item.id, truckId)) continue;
    item.location = spot;
    seeWhere(ctx, actor, item);
    moved = true;
  }
  if (isCarriedBy(ctx, truckId, actor.id)) {
    truck.location = spot;
    seeWhere(ctx, actor, truck);
    moved = true;
  }
  return moved;
}

/** Take a crate within reach onto the truck in hand. */
export function loadOntoTruck(ctx: StepCtx, actor: Actor, item: Item, truckId: ItemId): void {
  item.location = { kind: "inContainer", containerId: truckId };
  seeWhere(ctx, actor, item);
}

/** Set a crate (or the truck) down at the centre of the actor's tile. */
export function setDownHere(ctx: StepCtx, actor: Actor, item: Item): void {
  if (actor.location.kind !== "onDeck") return;
  const tile = tileOf(actor.location);
  item.location = {
    kind: "onDeck",
    deckId: actor.location.deckId,
    x: tile.x + 0.5,
    y: tile.y + 0.5,
  };
  seeWhere(ctx, actor, item);
}

/** Is the crate within the actor's reach (on deck, the same deck, at most a tile away)? */
export function withinReach(actor: Actor, item: Item): boolean {
  const location = item.location;
  const here = actor.location;
  if (location.kind !== "onDeck" || here.kind !== "onDeck") return false;
  return location.deckId === here.deckId && near(tileOf(location), tileOf(here));
}
