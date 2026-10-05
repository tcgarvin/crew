/**
 * Cleaning (D82): the `cleanCompartment` plan and its `mop` work stage.
 *
 * `cleanPlan`: the mop (in hand already, or the nearest one the actor knows of), then for each of
 * the room's tiles to mop (`tilesToMop`, in the trip's order, `tasks.ts`) a `moveTo` and
 * `mopSecondsPerTile` of `mop` work (`workRate`-scaled), then back to the `cleaningLocker` zone to `putDown` the mop, and last the
 * trip's settling: a `mop` step of no ticks. `runMop` on a tile sets its cell to
 * `max(0, cell − mopPerTile × 255)`; the settling step resolves `compartmentDirty` with
 * `roomCleaned` if the room is back to clean, or else bumps its revision so the next trip
 * re-derives the dirtiest tiles. Settling after the mop is put away means the task completes with
 * the mop in the locker: a problem resolved mid-trip would complete the task under the mopper and
 * leave the mop in their hands (`execute.ts` keeps a finished task's tools).
 *
 * The plan takes its tiles from the grid when it is built, not from the task's
 * `interactionTiles`: those are refreshed only by the next derivation pass after the settling's
 * revision bump, up to `DERIVATION_EVERY_TICKS` later, and the planner can re-claim the freed task
 * before then; a plan baked from them re-mopped the tiles the last trip had just cleaned (QA:
 * four trips in nine, one walking the corridor's length twice over clean floor). A trip re-planned
 * after an interruption likewise skips what it already mopped.
 *
 * Owner: W2 of ship life slice 3.
 */
import { configTicks } from "../../core/clock";
import { cellIndex, inGrid } from "../../core/dirt-grid";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { ItemId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep, ProblemOfKind, Task } from "../../core/types/work";
import {
  type PlanResult,
  acquireSteps,
  believedLocation,
  blocked,
  carriedItems,
  planOf,
  tileOf,
} from "../work/plans";
import { type StepResult, workRate } from "../work/steps";
import { CELL_MAX } from "./grid";
import { type Room, currentTier, resolveDirtProblem } from "./rooms";
import { tilesToMop } from "./tasks";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

/** The zone tag the mop lives in (`ZoneDef.tags`). */
const LOCKER_TAG = "cleaningLocker";

const isMop = (ctx: StepCtx, itemId: ItemId): boolean => {
  const item = ctx.state.items[itemId];
  return item !== undefined && (ctx.content.items[item.defId]?.toolKinds.includes("mop") ?? false);
};

/** A mop in the actor's hands (truth: they know what they carry). */
function mopInHand(ctx: StepCtx, actor: Actor): ItemId | undefined {
  return carriedItems(ctx, actor.id).find((item) => isMop(ctx, item.id))?.id;
}

/** The nearest mop the actor believes is on this deck, by straight-line distance. */
function nearestKnownMop(ctx: StepCtx, actor: Actor): ItemId | undefined {
  const here = actor.location.kind === "onDeck" ? tileOf(actor.location) : { x: 0, y: 0 };
  let best: { itemId: ItemId; d: number } | undefined;
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation") continue;
    const itemId = fact.subjectId as ItemId;
    const location = believedLocation(actor, itemId);
    if (location?.kind !== "onDeck" || !isMop(ctx, itemId)) continue;
    const d = Math.hypot(location.x - here.x, location.y - here.y);
    if (best === undefined || d < best.d || (d === best.d && itemId < best.itemId)) {
      best = { itemId, d };
    }
  }
  return best?.itemId;
}

/** Where the mop goes back: the first tile of a `cleaningLocker` zone on the actor's deck. */
function lockerTile(ctx: StepCtx, actor: Actor): TileCoord | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const deck = ctx.content.decks[actor.location.deckId];
  return deck?.zones.find((z) => z.tags.includes(LOCKER_TAG))?.tiles[0];
}

const moveTo = (tile: TileCoord): ActivityStep => ({
  kind: "moveTo",
  target: { x: tile.x, y: tile.y },
  requested: false,
});

export function cleanPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "compartment") return blocked("unreachableTarget");
  const tiles = tilesToMop(ctx, task.target.compartmentId);
  if (tiles.length === 0) return blocked("unreachableTarget");
  const held = mopInHand(ctx, actor);
  const mopId = held ?? nearestKnownMop(ctx, actor);
  if (mopId === undefined) return blocked("missingTool");
  const fetch = held === undefined ? acquireSteps(ctx, actor, mopId, false) : [];
  if (typeof fetch === "string") return blocked("missingTool");
  const strokeTicks = Math.max(1, configTicks(ctx.config, ctx.config.dirt.mopSecondsPerTile));
  const steps: ActivityStep[] = [...fetch];
  for (const tile of tiles) {
    steps.push(moveTo(tile), {
      kind: "work",
      stage: "mop",
      ticksDone: 0,
      ticksNeeded: strokeTicks,
    });
  }
  const locker = lockerTile(ctx, actor);
  if (locker !== undefined) steps.push(moveTo(locker), { kind: "putDown", itemId: mopId });
  steps.push({ kind: "work", stage: "mop", ticksDone: 0, ticksNeeded: 0 });
  return planOf(steps);
}

/** The room a `cleanCompartment` task is for, with its open problem. */
function taskRoom(
  ctx: StepCtx,
  task: Task,
): { room: Room; problem: ProblemOfKind<"compartmentDirty"> } | undefined {
  const problem = ctx.state.work.problems[task.problemId];
  if (problem?.kind !== "compartmentDirty" || problem.status !== "open") return undefined;
  const compartment = ctx.state.compartments[problem.payload.compartmentId];
  const def = ctx.content.decks[compartment?.deckId ?? ("" as never)]?.compartments.find(
    (c) => c.key === problem.payload.key,
  );
  if (compartment === undefined || def === undefined) return undefined;
  return { room: { deckId: compartment.deckId, def, compartmentId: compartment.id }, problem };
}

/** The trip is over and the mop put away: is the room clean now? */
function settleTrip(ctx: StepCtx, actor: Actor, task: Task): StepResult {
  const found = taskRoom(ctx, task);
  if (found === undefined) return "done";
  if (currentTier(ctx, found.room) === "clean") resolveDirtProblem(ctx, found.problem, actor.id);
  else found.problem.revision += 1;
  return "done";
}

export function runMop(ctx: StepCtx, actor: Actor, step: StepOf<"work">): StepResult {
  const activity = actor.activity;
  const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
  if (task === undefined) return { fail: "dependencyPending" };
  if (step.ticksNeeded === 0) return settleTrip(ctx, actor, task);
  if (taskRoom(ctx, task) === undefined) return { fail: "dependencyPending" };
  if (mopInHand(ctx, actor) === undefined) return { fail: "missingTool" };
  if (actor.location.kind !== "onDeck") return { fail: "unreachableTarget" };
  if (task.status === "claimed") task.status = "active";
  step.ticksDone += workRate(ctx, actor, task);
  if (step.ticksDone < step.ticksNeeded) return "wait";
  const deck = ctx.content.decks[actor.location.deckId];
  const cells = ctx.state.dirt.cells[actor.location.deckId];
  const tile = tileOf(actor.location);
  if (deck !== undefined && cells !== undefined && inGrid(deck, tile)) {
    const i = cellIndex(deck, tile);
    cells[i] = Math.max(0, (cells[i] ?? 0) - Math.round(ctx.config.dirt.mopPerTile * CELL_MAX));
  }
  // The mopper wipes their boots with the tile: otherwise what they picked up stepping onto the
  // dirtiest tile would be shed round the room on the way to the next.
  actor.boots = 0;
  return "done";
}
