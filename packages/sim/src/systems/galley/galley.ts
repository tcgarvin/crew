/**
 * The galley system (§meal-problem), phase `needs`, every tick, registered after the watch (the
 * bell first, then the meal that follows it). In order:
 *
 * 1. The meal problem: `mealToCook { watchIndex }` is raised `galley.mealLeadDays` before the
 *    coming watch's bell (once per watch: `state.galley.lastMealWatch`), only on a ship with a
 *    stove and someone aboard to feed; one not served by `mealGraceDays` after its bell is
 *    cancelled with `mealMissed`. The serve resolves it (`cook.ts`).
 * 2. Spoilage: a serving on deck past its `meal.spoilsAtTick` is swept (`mealSpoiled`, a
 *    `spoiledMeal` deposit on its tile). One in someone's hands is theirs to eat.
 * 3. The helm-stander's plate (call 5): while someone holds the helm hungry past
 *    `mealCallHungerAbove`, a meal is on deck and no serving lies within reach of the seat,
 *    `mealToCarry` is open (dedupe per helm, revised when the holder changes); it resolves once a
 *    plate is within reach (`mealCarried`, by whoever stands beside it), or when there is no
 *    longer anyone hungry at the helm or anything to carry.
 * 4. The helm meal: the holder with a serving within reach and hunger past the call threshold
 *    eats in the seat (`state.galley.helmMeal`, `needs.mealDays`, then `consumeServing`); the hold
 *    goes on throughout, so `whoHasTheHelm` never changes and no relief is called. A plate taken
 *    meanwhile, or the helm handed over, ends it with no effect.
 *
 * `provisionsLow` (narrative) is said at the serve that takes the crates under
 * `galley.lowBelowDays` (`cook.ts`); the purchase is commerce's `reserveLow`.
 *
 * Owner: W1 of ship life slice 3.
 */
import { dayTicks, watchIndexAt, watchTicks } from "../../core/clock";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { ActorId, DeckDefId, MachineId, ProblemId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ProblemOfKind } from "../../core/types/work";
import { depositDirt } from "../dirt/deposit";
import { helmMachine, whoHasTheHelm } from "../watch/helm";
import { emitSim } from "../work/events";
import { consumeServing } from "./eat";
import {
  isMeal,
  positionTiles,
  servingWithinReach,
  stoveOf,
  tileAt,
  unitsOf,
  withinArm,
} from "./kitchen";
import { eatersAboard } from "./provisions";

// ---------------------------------------------------------------------------------------------
// 1. The meal problem
// ---------------------------------------------------------------------------------------------

function openMeals(ctx: StepCtx): ProblemOfKind<"mealToCook">[] {
  return Object.values(ctx.state.work.problems).filter(
    (p): p is ProblemOfKind<"mealToCook"> => p.kind === "mealToCook" && p.status === "open",
  );
}

function raiseMeal(ctx: StepCtx, watchIndex: number, machineId: MachineId): void {
  const id = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[id] = {
    id,
    kind: "mealToCook",
    payload: { watchIndex },
    owner: "galley",
    visibility: "public",
    dedupeKey: `meal:${watchIndex}`,
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "machine", machineId },
  };
  emitSim(ctx, "problemRaised", [id], { problemId: id, kind: "mealToCook" });
}

/** Raise the coming watch's meal at its lead; give up any meal past its grace. */
function mealRhythm(ctx: StepCtx): void {
  const watch = watchTicks(ctx.config);
  const graceTicks = dayTicks(ctx.config, ctx.config.galley.mealGraceDays);
  for (const problem of openMeals(ctx)) {
    if (ctx.tick < problem.payload.watchIndex * watch + graceTicks) continue;
    problem.status = "cancelled";
    emitSim(ctx, "mealMissed", [problem.id], { watchIndex: problem.payload.watchIndex });
  }
  const next = watchIndexAt(ctx.config, ctx.tick) + 1;
  const raiseAt = next * watch - dayTicks(ctx.config, ctx.config.galley.mealLeadDays);
  if (ctx.tick < raiseAt || ctx.state.galley.lastMealWatch >= next) return;
  const stove = stoveOf(ctx.state, ctx.content);
  if (stove === undefined || eatersAboard(ctx.state) === 0) return;
  ctx.state.galley.lastMealWatch = next;
  raiseMeal(ctx, next, stove.id);
}

// ---------------------------------------------------------------------------------------------
// 2. Spoilage
// ---------------------------------------------------------------------------------------------

function sweepSpoiled(ctx: StepCtx): void {
  let count = 0;
  for (const item of Object.values(ctx.state.items)) {
    const location = item.location;
    if (item.meal === undefined || location.kind !== "onDeck") continue;
    if (ctx.tick < item.meal.spoilsAtTick) continue;
    count += unitsOf(item);
    delete ctx.state.items[item.id];
    depositDirt(
      ctx.state,
      ctx.content,
      ctx.config,
      location.deckId,
      tileAt(location),
      ctx.config.dirt.deposits.spoiledMeal,
    );
  }
  if (count === 0) return;
  ctx.dirty.inventory = true;
  emitSim(ctx, "mealSpoiled", [], { count });
}

// ---------------------------------------------------------------------------------------------
// 3. and 4. The helm's plate
// ---------------------------------------------------------------------------------------------

/** The one holding the helm, where they sit, and the helm. */
interface HelmSeat {
  readonly actor: Actor;
  readonly machineId: MachineId;
  readonly deckId: DeckDefId;
  readonly seat: TileCoord;
}

function helmSeat(ctx: StepCtx): HelmSeat | undefined {
  const helm = helmMachine(ctx.state, ctx.content);
  const holderId = whoHasTheHelm(ctx.state, ctx.content);
  const actor = holderId === undefined ? undefined : ctx.state.actors[holderId];
  if (helm === undefined || actor === undefined || actor.location.kind !== "onDeck") {
    return undefined;
  }
  return {
    actor,
    machineId: helm.id,
    deckId: actor.location.deckId,
    seat: tileAt(actor.location),
  };
}

const hungryForIt = (ctx: StepCtx, actor: Actor): boolean =>
  actor.needs.hunger > ctx.config.galley.mealCallHungerAbove;

/** The served meal within the holder's reach (on deck beside the seat, or in their hands). */
function plateAtHelm(ctx: StepCtx, at: HelmSeat): Item | undefined {
  return Object.values(ctx.state.items).find(
    (item) =>
      item.meal !== undefined &&
      isMeal(ctx.content, item) &&
      servingWithinReach(item, at.deckId, at.seat, at.actor.id),
  );
}

/**
 * Is there a served meal to bring up: on deck (the counter), or in someone's hands (the plate on
 * its way, which may have been the counter's last)?
 */
function mealToBring(ctx: StepCtx, at: HelmSeat): boolean {
  return Object.values(ctx.state.items).some((item) => {
    // Slice 4: a treat carries `meal` too (it spoils like a serving) but is nobody's plate.
    if (item.meal === undefined || !isMeal(ctx.content, item)) return false;
    const location = item.location;
    if (location.kind === "carriedBy") return location.actorId !== at.actor.id;
    return location.kind === "onDeck" && location.deckId === at.deckId;
  });
}

const carryKey = (machineId: MachineId): string => `mealToCarry:${machineId}`;

function openCarry(ctx: StepCtx): ProblemOfKind<"mealToCarry"> | undefined {
  return Object.values(ctx.state.work.problems).find(
    (p): p is ProblemOfKind<"mealToCarry"> => p.kind === "mealToCarry" && p.status === "open",
  );
}

/** Whoever set the plate down: the crew member nearest it, the holder aside, within reach. */
function carrierBeside(ctx: StepCtx, at: HelmSeat, plate: Item): ActorId | undefined {
  const location = plate.location;
  if (location.kind !== "onDeck") return undefined;
  const tile = tileAt(location);
  return Object.values(ctx.state.actors).find(
    (a) =>
      a.crew &&
      a.id !== at.actor.id &&
      a.location.kind === "onDeck" &&
      withinArm(tileAt(a.location), tile),
  )?.id;
}

function settleCarry(ctx: StepCtx, problem: ProblemOfKind<"mealToCarry">, plate?: Item): void {
  problem.status = "resolved";
  emitSim(ctx, "problemResolved", [problem.id], { problemId: problem.id, kind: problem.kind });
  if (plate === undefined) return;
  const at = helmSeat(ctx);
  const by = at === undefined ? undefined : carrierBeside(ctx, at, plate);
  if (by === undefined) return;
  emitSim(ctx, "mealCarried", [problem.payload.toActorId, by], {
    toActorId: problem.payload.toActorId,
    byActorId: by,
  });
}

/** Keep `mealToCarry` in step with the helm (see the module comment). */
function carryToHelm(ctx: StepCtx, at: HelmSeat | undefined): void {
  const open = openCarry(ctx);
  const plate = at === undefined ? undefined : plateAtHelm(ctx, at);
  const wanted =
    at !== undefined &&
    plate === undefined &&
    hungryForIt(ctx, at.actor) &&
    ctx.state.galley.helmMeal === undefined &&
    mealToBring(ctx, at);
  if (open !== undefined) {
    if (!wanted) {
      settleCarry(ctx, open, plate);
      return;
    }
    if (open.payload.toActorId !== at.actor.id) {
      open.payload = { toActorId: at.actor.id, machineId: at.machineId };
      open.revision += 1;
    }
    return;
  }
  if (!wanted) return;
  const id = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[id] = {
    id,
    kind: "mealToCarry",
    payload: { toActorId: at.actor.id, machineId: at.machineId },
    owner: "galley",
    visibility: "public",
    dedupeKey: carryKey(at.machineId),
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "machine", machineId: at.machineId },
  };
  emitSim(ctx, "problemRaised", [id], { problemId: id, kind: "mealToCarry" });
}

/** Start, finish or give up the meal eaten in the helm's seat. */
function helmMeal(ctx: StepCtx, at: HelmSeat | undefined): void {
  const galley = ctx.state.galley;
  const current = galley.helmMeal;
  if (current !== undefined) {
    const item = ctx.state.items[current.itemId];
    const still =
      at !== undefined &&
      at.actor.id === current.actorId &&
      item !== undefined &&
      servingWithinReach(item, at.deckId, at.seat, at.actor.id);
    if (!still) {
      // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
      delete galley.helmMeal;
      return;
    }
    if (ctx.tick - current.startedTick < dayTicks(ctx.config, ctx.config.needs.mealDays)) return;
    consumeServing(ctx, at.actor, item);
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete galley.helmMeal;
    return;
  }
  if (at === undefined || !hungryForIt(ctx, at.actor)) return;
  const plate = plateAtHelm(ctx, at);
  if (plate === undefined) return;
  galley.helmMeal = { actorId: at.actor.id, itemId: plate.id, startedTick: ctx.tick };
}

// ---------------------------------------------------------------------------------------------

export const galleySystem: System = {
  name: "galley",
  phase: "needs",
  run(ctx) {
    mealRhythm(ctx);
    sweepSpoiled(ctx);
    const at = helmSeat(ctx);
    helmMeal(ctx, at);
    carryToHelm(ctx, at);
  },
};

/** The helm's standby tiles (where a plate is set down), for tests and the digest. */
export function helmStandbyTiles(ctx: Pick<StepCtx, "state" | "content">): TileCoord[] {
  const helm = helmMachine(ctx.state, ctx.content);
  return helm === undefined ? [] : positionTiles(ctx.state, ctx.content, helm.id, "use");
}
