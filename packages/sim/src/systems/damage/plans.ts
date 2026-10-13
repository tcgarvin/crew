/**
 * Plans for damage work (§machine-damage, §scouts), built from what the actor believes about where
 * things are:
 *
 * - `repairDamagePlan`: the welder (in hand already, or the nearest one they know of) → the
 *   machine's `repair` position (any position on a machine with none, else a tile of the task) →
 *   `mend` work until the machine is whole (`steps.ts` `runMend`; the step's ticks are the
 *   estimate, the machine's integrity is the progress).
 * - `patchPlan` / `platePlan`: the welder, then one kit or plate split off the nearest stack they
 *   know of (by tag), → the tile beside the scar nearest them → `patch` for `patchSeconds` or
 *   `plate` for `plateSeconds`, whose end is the commit (`runPatch`, `runPlate`).
 * - `checkPlan`: the scout's walk to the room's door tile nearest them, then `check` for
 *   `checkSeconds` (`runCheck`: a look round, and the check resolved).
 * - `holdBridgePlan`: the officer of the watch to the captain's chair's `use` position on the
 *   bridge (a chair anywhere on a ship with none on the bridge), else the bridge's first open
 *   floor tile, and a `bridge` hold there (`bridgeHoldDone`).
 *
 * A plan that cannot find its tool or supply is blocked `missingTool` / `inaccessibleSupply`
 * (task-level: every candidate backs off), one with nowhere to stand `unreachableTarget`.
 *
 * Owner: W2 of ship life slice 5.
 */
import { configTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { ItemTag, ToolKind } from "../../core/types/content";
import type { ItemId, MachineId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ActivityStep, BlockageReason, StepTarget, Task } from "../../core/types/work";
import { estimateTravelTicks } from "../spatial/estimates";
import { compartmentAt, isStaticWalkable } from "../spatial/geometry";
import {
  type PlanResult,
  acquireSteps,
  blocked,
  carriedItems,
  interactionTarget,
  planOf,
  tileOf,
} from "../work/plans";
import { chebyshev } from "./deck";

/** The tile the actor stands on, when on deck. */
function here(actor: Actor): TileCoord | undefined {
  return actor.location.kind === "onDeck" ? tileOf(actor.location) : undefined;
}

function geometryOf(ctx: StepCtx, actor: Actor): DeckGeometry | undefined {
  return actor.location.kind === "onDeck" ? ctx.caches.nav.decks[actor.location.deckId] : undefined;
}

/** Ticks to walk from where the actor stands to `to`, or null with no route. */
function walkTicks(ctx: StepCtx, actor: Actor, to: TileCoord): number | null {
  const geometry = geometryOf(ctx, actor);
  const from = here(actor);
  if (geometry === undefined || from === undefined) return null;
  return estimateTravelTicks(geometry, from, to, ctx.config, 1, ctx.caches);
}

/** The reachable tile of `tiles` the actor can walk to soonest (ties by the given order). */
export function nearestReachable(
  ctx: StepCtx,
  actor: Actor,
  tiles: readonly TileCoord[],
): TileCoord | undefined {
  let best: { tile: TileCoord; ticks: number } | undefined;
  for (const tile of tiles) {
    const ticks = walkTicks(ctx, actor, tile);
    if (ticks !== null && (best === undefined || ticks < best.ticks)) best = { tile, ticks };
  }
  return best?.tile;
}

const moveTo = (target: StepTarget): ActivityStep => ({
  kind: "moveTo",
  target: "machineId" in target ? target : { x: target.x, y: target.y },
  requested: false,
});

const work = (stage: "mend" | "patch" | "plate" | "check", ticks: number): ActivityStep => ({
  kind: "work",
  stage,
  ticksDone: 0,
  ticksNeeded: Math.max(1, ticks),
});

const isTool = (ctx: StepCtx, item: Pick<Item, "defId">, kind: ToolKind): boolean =>
  ctx.content.items[item.defId]?.toolKinds.includes(kind) === true;

const isTagged = (ctx: StepCtx, item: Pick<Item, "defId">, tag: ItemTag): boolean =>
  ctx.content.items[item.defId]?.tags.includes(tag) === true;

/** A welder in the actor's hands (truth: they know what they carry). */
export function welderInHand(ctx: StepCtx, actor: Actor): Item | undefined {
  return carriedItems(ctx, actor.id).find((item) => isTool(ctx, item, "welder"));
}

/** A carried unit tagged `tag` (a kit or a plate). */
export function taggedInHand(ctx: StepCtx, actor: Actor, tag: ItemTag): Item | undefined {
  return carriedItems(ctx, actor.id).find((item) => isTagged(ctx, item, tag));
}

/**
 * The items the actor believes are on deck and match `matches` (what an item is comes from truth,
 * as in the planner's view; where it is, from belief), nearest walk first.
 */
export function knownOnDeck(
  ctx: StepCtx,
  actor: Actor,
  matches: (item: Item) => boolean,
): ItemId[] {
  const found: { itemId: ItemId; ticks: number }[] = [];
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation" || fact.value.absent === true) continue;
    const location = fact.value.location;
    if (location.kind !== "onDeck") continue;
    const item = ctx.state.items[fact.subjectId as ItemId];
    if (item === undefined || !matches(item)) continue;
    const ticks = walkTicks(ctx, actor, tileOf(location));
    if (ticks !== null) found.push({ itemId: item.id, ticks });
  }
  found.sort((a, b) => a.ticks - b.ticks || (a.itemId < b.itemId ? -1 : 1));
  return found.map((f) => f.itemId);
}

/** Steps to have a welder in hand. */
function welderSteps(ctx: StepCtx, actor: Actor): ActivityStep[] | BlockageReason {
  if (welderInHand(ctx, actor) !== undefined) return [];
  const [welderId] = knownOnDeck(ctx, actor, (item) => isTool(ctx, item, "welder"));
  if (welderId === undefined) return "missingTool";
  const acquire = acquireSteps(ctx, actor, welderId, false);
  return typeof acquire === "string" ? "missingTool" : acquire;
}

/** Steps to have one unit tagged `tag` in hand, split off the nearest known stack. */
function supplySteps(ctx: StepCtx, actor: Actor, tag: ItemTag): ActivityStep[] | BlockageReason {
  if (taggedInHand(ctx, actor, tag) !== undefined) return [];
  const [stockId] = knownOnDeck(ctx, actor, (item) => isTagged(ctx, item, tag));
  if (stockId === undefined) return "inaccessibleSupply";
  return acquireSteps(ctx, actor, stockId, true);
}

export function repairDamagePlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "machine") return blocked("unreachableTarget");
  const machineId = task.target.machineId;
  const machine = ctx.state.machines[machineId];
  if (machine === undefined) return blocked("unreachableTarget");
  const tools = welderSteps(ctx, actor);
  if (typeof tools === "string") return blocked(tools);
  const position = interactionTarget(ctx, actor, machineId, "repair");
  const stand = position ?? nearestReachable(ctx, actor, task.interactionTiles);
  if (stand === undefined) return blocked("unreachableTarget");
  const missing = Math.max(0, 1 - machine.integrity);
  const ticks = Math.ceil(
    configTicks(ctx.config, ctx.config.damage.repairSecondsPerIntegrity * missing),
  );
  return planOf([...tools, moveTo(stand), work("mend", ticks)]);
}

/** The welder and one unit tagged `tag`, beside the scar, and the work. */
function hullPlan(
  ctx: StepCtx,
  actor: Actor,
  task: Task,
  tag: "patchKit" | "plating",
  stage: "patch" | "plate",
  seconds: number,
): PlanResult {
  if (task.target.kind !== "scar") return blocked("unreachableTarget");
  const scarId = task.target.scarId;
  if (!ctx.state.hull.scars.some((s) => s.id === scarId)) return blocked("unreachableTarget");
  const tools = welderSteps(ctx, actor);
  if (typeof tools === "string") return blocked(tools);
  const supply = supplySteps(ctx, actor, tag);
  if (typeof supply === "string") return blocked(supply);
  const stand = nearestReachable(ctx, actor, task.interactionTiles);
  if (stand === undefined) return blocked("unreachableTarget");
  return planOf([
    ...tools,
    ...supply,
    moveTo(stand),
    work(stage, configTicks(ctx.config, seconds)),
  ]);
}

export function patchPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  return hullPlan(ctx, actor, task, "patchKit", "patch", ctx.config.damage.patchSeconds);
}

export function platePlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  return hullPlan(ctx, actor, task, "plating", "plate", ctx.config.damage.plateSeconds);
}

export function checkPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "compartment") return blocked("unreachableTarget");
  const door = nearestReachable(ctx, actor, task.interactionTiles);
  if (door === undefined) return blocked("unreachableTarget");
  return planOf([
    moveTo(door),
    work("check", configTicks(ctx.config, ctx.config.damage.checkSeconds)),
  ]);
}

/** A chair's `use` position on the bridge (a chair anywhere if none is there). */
function chairOnTheBridge(ctx: StepCtx, actor: Actor): StepTarget | undefined {
  const geometry = geometryOf(ctx, actor);
  if (geometry === undefined) return undefined;
  const bridges = bridgeCompartments(ctx, actor);
  let anywhere: StepTarget | undefined;
  for (const position of geometry.interactionPositions) {
    if (!position.purposes.includes("use")) continue;
    const machine = ctx.state.machines[position.machineId as MachineId];
    const tags = machine === undefined ? [] : (ctx.content.machines[machine.defId]?.tags ?? []);
    if (!tags.includes("chair")) continue;
    const target = { machineId: position.machineId, positionKey: position.key };
    const room = compartmentAt(geometry, position.tile.x, position.tile.y);
    if (room !== undefined && bridges.has(room)) return target;
    anywhere ??= target;
  }
  return anywhere;
}

/** The compartments of the actor's deck tagged `bridge`. */
function bridgeCompartments(ctx: StepCtx, actor: Actor): Set<string> {
  const out = new Set<string>();
  if (actor.location.kind !== "onDeck") return out;
  const deck = ctx.content.decks[actor.location.deckId];
  const keys = new Set(
    (deck?.compartments ?? []).filter((c) => c.tags.includes("bridge")).map((c) => c.key),
  );
  for (const compartment of Object.values(ctx.state.compartments)) {
    if (compartment.deckId === actor.location.deckId && keys.has(compartment.key)) {
      out.add(compartment.id);
    }
  }
  return out;
}

/** The bridge's first open floor tile that is no machine's position, row-major. */
function bridgeFloor(ctx: StepCtx, actor: Actor): TileCoord | undefined {
  const geometry = geometryOf(ctx, actor);
  if (geometry === undefined) return undefined;
  const bridges = bridgeCompartments(ctx, actor);
  const positions = new Set(geometry.interactionPositions.map((p) => `${p.tile.x},${p.tile.y}`));
  for (let y = geometry.originY; y < geometry.originY + geometry.height; y++) {
    for (let x = geometry.originX; x < geometry.originX + geometry.width; x++) {
      const room = compartmentAt(geometry, x, y);
      if (room === undefined || !bridges.has(room) || !isStaticWalkable(geometry, x, y)) continue;
      if (!positions.has(`${x},${y}`)) return { x, y };
    }
  }
  return undefined;
}

export function holdBridgePlan(ctx: StepCtx, actor: Actor): PlanResult {
  const post = chairOnTheBridge(ctx, actor) ?? bridgeFloor(ctx, actor);
  if (post === undefined) return blocked("unreachableTarget");
  return planOf([moveTo(post), { kind: "hold", hold: "bridge", sinceTick: ctx.tick }]);
}

/** Is `tile` within arm's reach of `target` (the same tile or one of its eight neighbours)? */
export const besides = (tile: TileCoord, target: TileCoord): boolean =>
  chebyshev(tile, target) <= 1;
