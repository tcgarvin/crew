/**
 * Advancing one plan step against truth (SD §14.3–14.7). A step either finishes, waits, or fails
 * with a structured `BlockageReason`; `execute.ts` owns what happens next.
 *
 * W4a decisions:
 * - Recipe stages (inspect/diagnose, repair, maintain) are driven through equipment's
 *   `advanceStage` (W5), injected as a `StageExecutor` so tests can stub it. Work per tick is
 *   `manipulation × trait workSpeed × (1 + workSpeedPerSkillLevel × levels above the task's
 *   first skill requirement)` ticks of recipe progress.
 * - Eating takes one unit off the believed stack at pickup (split into a carried unit of 1) and
 *   consumes it at the end of `mealDays`: the stack on the floor drops by exactly one. Hunger
 *   falls by the item's `nutrition` (food without one fully satisfies). D81: the consume step and
 *   the galley's `cook`/`serve` are `systems/galley/`'s; D82: the `mop` stage is `systems/dirt/`'s.
 * - Sleep ends after `sleepDays` once fatigue ≤ `wakeBelow`, or once the actor is on duty (D77:
 *   their watch, or a dayworker's hours) and fatigue is below `seekThreshold`. Rest/socialize holds end when their need is
 *   fully met while on duty; off duty they last until the planner finds something more urgent.
 * - A helm hold (`staff`) ends when the stander is relieved or the watch post closes (D77,
 *   `systems/watch/helm.ts`); while it lasts the stander learns piloting (`skillGainPerDay`,
 *   capped at 10). A gangway hold ends when the ship sails or they are no longer the stander.
 * - A route that ended early (`movement.routeFailure`, W3's "replan now") fails the step:
 *   `positionTaken` → `occupiedPosition`, anything else → `unreachableTarget`.
 */
import { rebuildItemIndexes } from "../../core/caches";
import { configTicks, dayTicks, perDayToPerSecond } from "../../core/clock";
import { deliverHeldCard, heldCard } from "../../core/delivery";
import { marketCounter } from "../../core/docks";
import { allocateId } from "../../core/ids";
import { moodWorkFactor } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { ActorId, ItemId, PortDefId, TaskId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { ActivityStep, BlockageReason, StepTarget, Task } from "../../core/types/work";
import { buyFromMarket, marketStoreLocation, setDownBought } from "../commerce/market";
import { runMop } from "../dirt/clean";
import { depositDirt } from "../dirt/deposit";
import type { RecipeCtx, RecipeOutcome } from "../equipment/recipes";
import { advanceStage } from "../equipment/recipes";
import { runCook, runServe } from "../galley/cook";
import { runConsume } from "../galley/eat";
import { compartmentAt } from "../spatial/geometry";
import { requestMove } from "../spatial/movement";
import { releaseReservations } from "../spatial/reservations";
import { runPlot } from "../travel/course";
import { isOnDuty } from "../watch/duty";
import { gangwayHoldDone, helmHoldDone, holdsTheHelm, runHandover } from "../watch/helm";
import { backoffRef, currentStep, isOutThroughGate } from "./activity";
import { setBackoff } from "./backoff";
import { isCompletionMet } from "./claims";
import { isTerminal } from "./derivation";
import { emitSim } from "./events";
import { directSight, seeItem, writeFact } from "./facts";
import { believedLocation, carriedItems, isCarriedBy, near, tileOf } from "./plans";
import { meetingAhead } from "./shore";
import { dropLeg, loadOntoTruck, onTruck, setDownHere, withinReach } from "./truck";

/** Drives recipe stages owned by equipment (W5). */
export interface StageExecutor {
  advance(ctx: RecipeCtx, taskId: TaskId, actorId: ActorId, ticks: number): RecipeOutcome;
}

export const equipmentStages: StageExecutor = { advance: advanceStage };

export interface WorkDeps {
  readonly stages: StageExecutor;
}

export type StepResult = "done" | "wait" | { readonly fail: BlockageReason };

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

export function touchInventory(ctx: StepCtx): void {
  ctx.dirty.inventory = true;
  rebuildItemIndexes(ctx.state, ctx.caches.index);
}

function actorTile(actor: Actor): TileCoord | undefined {
  return actor.location.kind === "onDeck" ? tileOf(actor.location) : undefined;
}

function resolveTile(ctx: StepCtx, actor: Actor, target: StepTarget): TileCoord | undefined {
  if (!("machineId" in target)) return target;
  if (actor.location.kind !== "onDeck") return undefined;
  return ctx.caches.nav.decks[actor.location.deckId]?.interactionPositions.find(
    (p) => p.machineId === target.machineId && p.key === target.positionKey,
  )?.tile;
}

function onTransferTile(ctx: StepCtx, actor: Actor): boolean {
  const here = actorTile(actor);
  if (here === undefined || actor.location.kind !== "onDeck") return false;
  const deck = ctx.content.decks[actor.location.deckId];
  return deck?.docking.cargoTransferTiles.some((t) => near(t, here)) ?? false;
}

function dockedAt(ctx: StepCtx, portId: string): boolean {
  return ctx.state.travel.stage === "docked" && ctx.state.travel.portId === portId;
}

/** D47/D63: is the actor where `portId`'s market is dealt with (`marketCounter`)? */
function atMarketCounter(ctx: StepCtx, actor: Actor, portId: PortDefId): boolean {
  const counter = marketCounter(ctx.content, ctx.state, portId);
  if (counter.kind === "transferTile") return onTransferTile(ctx, actor);
  const here = actorTile(actor);
  return here !== undefined && near(here, counter.tile);
}

/** Count one tick of a timed step; returns whether its time is up. */
function countTick(step: { ticksDone: number; readonly ticksNeeded: number }): boolean {
  step.ticksDone += 1;
  return step.ticksDone >= step.ticksNeeded;
}

// ---------------------------------------------------------------------------------------------
// The gate (D63)
// ---------------------------------------------------------------------------------------------

/**
 * D63: out through the gate on a market errand. The buyer leaves the map into the port's market
 * store and is off ship (so the planner, needs and the dock leave them be) until the step brings
 * them back.
 */
function stepOutThroughGate(ctx: StepCtx, actor: Actor, portId: PortDefId): void {
  releaseReservations(ctx.caches, actor.id);
  actor.movement = { kind: "stationary" };
  actor.location = marketStoreLocation(ctx.defs.port(portId));
  actor.availability = "offShip";
}

/**
 * Back through the gate onto the dock at `gate`. Travel never casts the dock off while someone is
 * out on an errand (it waits for them, or ends the errand first, `systems/travel/ashore.ts`), so
 * the dock is there to come back to; anything else is a broken invariant.
 */
function stepBackThroughGate(ctx: StepCtx, actor: Actor, gate: TileCoord): void {
  const presence = ctx.state.deck.dock;
  if (presence === undefined) {
    throw new Error(`${actor.id} is out through the gate with no dock alongside to come back to`);
  }
  actor.location = { kind: "onDeck", deckId: presence.deckId, x: gate.x + 0.5, y: gate.y + 0.5 };
  actor.availability = "available";
}

/** End a gate errand early (recall, abort): the buyer comes straight back to the gate. */
export function endGateErrand(ctx: StepCtx, actor: Actor): void {
  const step = currentStep(actor.activity);
  if (step?.kind === "throughGate" && isOutThroughGate(actor)) {
    stepBackThroughGate(ctx, actor, step.gate);
  }
}

/**
 * D63: the market is through the gate. Standing at the gate, step out (off ship) and spend the
 * counter time there; then come back to the gate tile. Fails `rampClosed` if the ship is no longer
 * docked at the port before stepping out, and `unreachableTarget` away from the gate.
 */
function runThroughGate(ctx: StepCtx, actor: Actor, step: StepOf<"throughGate">): StepResult {
  if (actor.location.kind === "onDeck") {
    if (!dockedAt(ctx, step.portId)) return { fail: "rampClosed" };
    const here = actorTile(actor);
    if (here === undefined || !near(here, step.gate)) return { fail: "unreachableTarget" };
    stepOutThroughGate(ctx, actor, step.portId);
    noteGoingToSee(ctx, actor);
  }
  if (!countTick(step)) return "wait";
  stepBackThroughGate(ctx, actor, step.gate);
  return "done";
}

/** D70: out through the gate to see a held card's speaker: say so in the log. */
function noteGoingToSee(ctx: StepCtx, actor: Actor): void {
  const decisionId = meetingAhead(actor);
  const held = decisionId === undefined ? undefined : heldCard(ctx.state, decisionId);
  if (held === undefined) return;
  emitSim(ctx, "wentToSee", [actor.id], {
    actorId: actor.id,
    name: actor.name,
    withName: held.speaker,
  });
}

// ---------------------------------------------------------------------------------------------
// Moving and handling items
// ---------------------------------------------------------------------------------------------

function runMove(ctx: StepCtx, actor: Actor, step: StepOf<"moveTo">): StepResult {
  const tile = resolveTile(ctx, actor, step.target);
  if (tile === undefined) return { fail: "unreachableTarget" };
  if (!step.requested) {
    step.requested = true;
    if (!requestMove(ctx.state, actor.id, step.target, ctx.caches, ctx.config)) {
      return { fail: "unreachableTarget" };
    }
  }
  const movement = actor.movement;
  if (movement.kind === "moving") return "wait";
  const here = actorTile(actor);
  if (here !== undefined && here.x === tile.x && here.y === tile.y) return "done";
  if (movement.routeFailure !== undefined) {
    return {
      fail:
        movement.routeFailure.reason === "positionTaken" ? "occupiedPosition" : "unreachableTarget",
    };
  }
  // Stopped short without a failure (e.g. an interrupted walk): ask again next tick.
  step.requested = false;
  return "wait";
}

/** Record what the actor now believes after looking for `itemId` and not finding it in reach. */
function noteDiscrepancy(ctx: StepCtx, actor: Actor, itemId: ItemId): void {
  const item = ctx.state.items[itemId];
  const location = actor.location;
  const geometry = location.kind === "onDeck" ? ctx.caches.nav.decks[location.deckId] : undefined;
  if (item?.location.kind === "onDeck" && geometry !== undefined && location.kind === "onDeck") {
    const here = compartmentAt(geometry, location.x, location.y);
    if (here !== undefined && compartmentAt(geometry, item.location.x, item.location.y) === here) {
      seeItem(actor, itemId, item.location, ctx.tick);
      return;
    }
  }
  const believed = believedLocation(actor, itemId);
  if (believed !== undefined) {
    const absent = { location: believed, absent: true } as const;
    writeFact(actor, itemId, "itemLocation", absent, directSight(actor, ctx.tick));
  }
}

/** `itemId` is not where the actor looked for it: note what they now believe, and fail. */
function notFound(ctx: StepCtx, actor: Actor, itemId: ItemId): StepResult {
  noteDiscrepancy(ctx, actor, itemId);
  return { fail: "inaccessibleSupply" };
}

function takeItem(ctx: StepCtx, actor: Actor, item: Item, split: boolean): ItemId {
  if (split && item.stacking === "stack" && item.count - item.reserved > 1) {
    const id = allocateId(ctx.state, "item");
    item.count -= 1;
    ctx.state.items[id] = {
      id,
      defId: item.defId,
      stacking: "stack",
      count: 1,
      reserved: 0,
      location: { kind: "carriedBy", actorId: actor.id },
      // The split-off unit is still freight for the same job (see `ItemBase.jobId`); dropping it
      // here would un-attribute the crate mid-haul (jobs.ts `deliveryComplete`/`raiseUnloadProblems`
      // key off `job.cargoItemIds`, which already names this new id, not `jobId` on the item, but
      // other freight-aware code — inspection, the crate renderer — reads `item.jobId`).
      ...(item.jobId === undefined ? {} : { jobId: item.jobId }),
      // A serving split off a served stack is the same dinner (D81): the plate keeps its quality
      // and spoils when the stack does.
      ...(item.meal === undefined ? {} : { meal: { ...item.meal } }),
    };
    return id;
  }
  item.location = { kind: "carriedBy", actorId: actor.id };
  return item.id;
}

function runPickUp(ctx: StepCtx, actor: Actor, step: StepOf<"pickUp">): StepResult {
  if (isCarriedBy(ctx, step.itemId, actor.id)) return "done";
  const item = ctx.state.items[step.itemId];
  if (item === undefined) return notFound(ctx, actor, step.itemId);
  if (!withinReach(actor, item)) {
    // Not on the deck within reach: only a port store across the ramp is left.
    const location = item.location;
    if (location.kind !== "inExternalStore" || !onTransferTile(ctx, actor)) {
      return notFound(ctx, actor, step.itemId);
    }
    if (!dockedAt(ctx, location.portId)) return { fail: "rampClosed" };
  }
  const takenId = takeItem(ctx, actor, item, step.split);
  if (takenId !== item.id) {
    // Later steps (the meal's consume, the carried plate's putDown) refer to the unit in hand.
    const activity = actor.activity;
    for (const later of activity.kind === "idle" ? [] : (activity.plan?.steps ?? [])) {
      if ((later.kind === "consume" || later.kind === "putDown") && later.itemId === item.id) {
        later.itemId = takenId;
      }
    }
    seeItem(actor, item.id, item.location, ctx.tick);
  }
  seeItem(actor, takenId, { kind: "carriedBy", actorId: actor.id }, ctx.tick);
  touchInventory(ctx);
  return "done";
}

function runPutDown(ctx: StepCtx, actor: Actor, step: StepOf<"putDown">): StepResult {
  const item = ctx.state.items[step.itemId];
  if (item === undefined || !isCarriedBy(ctx, item.id, actor.id)) {
    return { fail: "inaccessibleSupply" };
  }
  const location = actor.location;
  if (location.kind !== "onDeck") return { fail: "unreachableTarget" };
  const activity = actor.activity;
  const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
  const completion = task?.completion;
  if (completion?.kind === "itemInStore") {
    if (!onTransferTile(ctx, actor) || !dockedAt(ctx, completion.portId))
      return { fail: "rampClosed" };
    item.location = {
      kind: "inExternalStore",
      portId: completion.portId,
      storeKey: completion.storeKey,
    };
  } else {
    const tile = tileOf(location);
    item.location = { kind: "onDeck", deckId: location.deckId, x: tile.x + 0.5, y: tile.y + 0.5 };
    // D82: a crate set down leaves its mark on the deck.
    if (ctx.content.items[item.defId]?.tags.includes("cargo") === true) {
      depositDirt(
        ctx.state,
        ctx.content,
        ctx.config,
        location.deckId,
        tile,
        ctx.config.dirt.deposits.cargo,
      );
    }
  }
  seeItem(actor, item.id, item.location, ctx.tick);
  touchInventory(ctx);
  return "done";
}

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

/**
 * How fast `actor` works `task`: manipulation, trait `workSpeed`, levels above the task's first
 * skill requirement, and (D79) mood. Exported for timed work outside recipes (D78's plot).
 */
export function workRate(ctx: StepCtx, actor: Actor, task: Task): number {
  const requirement = task.requiredSkills[0];
  const levelsAbove =
    requirement === undefined
      ? 0
      : Math.max(0, (actor.skills[requirement.skill] ?? 0) - requirement.min);
  let trait = 1;
  for (const traitId of actor.traits) trait *= ctx.defs.trait(traitId).modifiers.workSpeed ?? 1;
  const skill = 1 + ctx.config.work.workSpeedPerSkillLevel * levelsAbove;
  const mood = moodWorkFactor(actor, ctx.config);
  return Math.max(0, actor.capacities.manipulation) * trait * skill * mood;
}

function hasTools(ctx: StepCtx, actor: Actor, task: Task): boolean {
  const carried = carriedItems(ctx, actor.id);
  return task.requiredTools.every((kind) =>
    carried.some((item) => ctx.content.items[item.defId]?.toolKinds.includes(kind)),
  );
}

function runRecipe(ctx: StepCtx, deps: WorkDeps, actor: Actor): StepResult {
  const activity = actor.activity;
  if (activity.kind !== "task") return { fail: "dependencyPending" };
  const task = ctx.state.work.tasks[activity.taskId];
  if (task === undefined) return { fail: "dependencyPending" };
  if (!hasTools(ctx, actor, task)) return { fail: "missingTool" };
  if (task.status === "claimed") task.status = "active";
  const recipeCtx: RecipeCtx = {
    state: ctx.state,
    content: ctx.content,
    config: ctx.config,
    tick: ctx.tick,
  };
  const outcome = deps.stages.advance(recipeCtx, task.id, actor.id, workRate(ctx, actor, task));
  switch (outcome.status) {
    case "notFound":
      return isCompletionMet(ctx.state, ctx.content, task) ? "done" : { fail: "unknownDiagnosis" };
    case "inProgress":
      return "wait";
    case "stepComplete":
      for (const event of outcome.events) ctx.emit(event);
      return "wait";
    case "recipeComplete":
      for (const event of outcome.events) ctx.emit(event);
      touchInventory(ctx);
      return "done";
  }
}

// ---------------------------------------------------------------------------------------------
// Buying (D47, D63)
// ---------------------------------------------------------------------------------------------

/**
 * D47 commit point: the purchase. Fails `rampClosed` if the ship is no longer docked at the
 * market's port, `unreachableTarget` off the transfer tile, and `inaccessibleSupply` (task-level,
 * so every candidate backs off) when the stock or the money ran out since the plan was made.
 */
function runBuy(ctx: StepCtx, actor: Actor, step: StepOf<"buy">): StepResult {
  if (!dockedAt(ctx, step.portId)) return { fail: "rampClosed" };
  if (!atMarketCounter(ctx, actor, step.portId)) return { fail: "unreachableTarget" };
  const handover = step.intoHands === true ? "hands" : "feet";
  const bought = buyFromMarket(ctx, actor, step.portId, step.itemDefId, step.count, handover);
  if (bought === undefined) return { fail: "inaccessibleSupply" };
  return "done";
}

/** D63: the bought units are aboard; set them down here. Nothing in hand is a lost purchase. */
function runStowBought(ctx: StepCtx, actor: Actor, step: StepOf<"stowBought">): StepResult {
  if (actor.location.kind !== "onDeck") return { fail: "unreachableTarget" };
  const set = setDownBought(ctx, actor, step.itemDefId);
  return set.length === 0 ? { fail: "inaccessibleSupply" } : "done";
}

// ---------------------------------------------------------------------------------------------
// The hand truck (D65)
// ---------------------------------------------------------------------------------------------

/** The activity's hand-truck trip, if it is one. */
function haulBatch(actor: Actor) {
  return actor.activity.kind === "task" ? actor.activity.haul : undefined;
}

/** The live haul task moving `itemId`, if any. */
function haulTaskFor(ctx: StepCtx, itemId: ItemId): Task | undefined {
  return Object.values(ctx.state.work.tasks).find(
    (t) => !isTerminal(t) && t.target.kind === "item" && t.target.itemId === itemId,
  );
}

/**
 * Take a crate within reach onto the truck in hand. A leg's crate that is not where the actor
 * thought drops that leg (noted, backed off, released) and the trip goes on; the lead's fails the
 * trip as a hand haul would.
 */
function runLoadTruck(ctx: StepCtx, actor: Actor, step: StepOf<"loadTruck">): StepResult {
  if (onTruck(ctx.state, step.itemId, step.truckId)) return "done";
  if (!isCarriedBy(ctx, step.truckId, actor.id)) return { fail: "missingTool" };
  const item = ctx.state.items[step.itemId];
  if (item !== undefined && withinReach(actor, item)) {
    loadOntoTruck(ctx, actor, item, step.truckId);
    touchInventory(ctx);
    return "done";
  }
  noteDiscrepancy(ctx, actor, step.itemId);
  const batch = haulBatch(actor);
  const leg = haulTaskFor(ctx, step.itemId);
  if (batch === undefined || !dropLeg(ctx, actor, batch, step.itemId, "failed")) {
    return { fail: "inaccessibleSupply" };
  }
  if (leg !== undefined) setBackoff(ctx, actor, backoffRef.task(leg.id));
  dropUnloadStep(actor, step.itemId);
  return "done";
}

/** Remove the later `unloadTruck` step of a dropped leg's crate from the plan. */
function dropUnloadStep(actor: Actor, itemId: ItemId): void {
  const activity = actor.activity;
  if (activity.kind !== "task" || activity.plan === undefined) return;
  const plan = activity.plan;
  plan.steps = plan.steps.filter(
    (s, i) => i <= plan.stepIndex || s.kind !== "unloadTruck" || s.itemId !== itemId,
  );
}

/** Set a crate down off the truck here; a leg's task settles at once. */
function runUnloadTruck(ctx: StepCtx, actor: Actor, step: StepOf<"unloadTruck">): StepResult {
  const item = ctx.state.items[step.itemId];
  if (item === undefined || !onTruck(ctx.state, step.itemId, step.truckId)) {
    return { fail: "inaccessibleSupply" };
  }
  if (actor.location.kind !== "onDeck") return { fail: "unreachableTarget" };
  setDownHere(ctx, actor, item);
  touchInventory(ctx);
  const batch = haulBatch(actor);
  if (batch !== undefined) dropLeg(ctx, actor, batch, step.itemId, "failed");
  return "done";
}

/** The trip is over; set the empty truck down here, aboard. */
function runParkTruck(ctx: StepCtx, actor: Actor, step: StepOf<"parkTruck">): StepResult {
  const truck = ctx.state.items[step.truckId];
  if (truck === undefined || !isCarriedBy(ctx, truck.id, actor.id)) {
    return { fail: "missingTool" };
  }
  if (actor.location.kind !== "onDeck") return { fail: "unreachableTarget" };
  setDownHere(ctx, actor, truck);
  touchInventory(ctx);
  return "done";
}

// ---------------------------------------------------------------------------------------------
// Ashore (D70)
// ---------------------------------------------------------------------------------------------

/**
 * D70 `lookForWork`: on the dock, waiting for the answer to this docking's `captainAshore` ask.
 * Commerce raises the ask the tick the actor stands on dock floor; the world halts on it, so the
 * first tick this sees it recorded the answer is in. A card the answer held for the captain ends
 * the activity here (commerce sends them to the speaker next, `meetSpeaker`); otherwise the look
 * round that follows in the plan goes ahead.
 */
function runAwaitWord(ctx: StepCtx, actor: Actor, step: StepOf<"awaitWord">): StepResult {
  if (ctx.state.narrator.captainAshoreLastAsk?.portId !== step.portId) return "wait";
  const activity = actor.activity;
  const waiting = ctx.state.decisions.held.some(
    (h) => h.portId === step.portId && h.delivery?.via !== "speaker",
  );
  if (waiting && activity.kind !== "idle" && activity.plan !== undefined) {
    activity.plan.steps = activity.plan.steps.slice(0, activity.plan.stepIndex + 1);
  }
  return "done";
}

/**
 * D70: talking with someone on the dock before their card comes up. The first tick says so in the
 * log; the talk runs its course even if they shuffle a step away.
 */
function runTalk(ctx: StepCtx, actor: Actor, step: StepOf<"talk">): StepResult {
  if (step.ticksDone === 0) {
    emitSim(ctx, "talkingWith", [actor.id, step.localId], {
      actorId: actor.id,
      name: actor.name,
      withName: step.withName,
    });
  }
  return countTick(step) ? "done" : "wait";
}

// ---------------------------------------------------------------------------------------------
// Holds and dispatch
// ---------------------------------------------------------------------------------------------

/** Skills are levels in [0, 10] (W0); learning at the helm stops at the top. */
const SKILL_CAP = 10;

/** D77: a tick at the helm teaches piloting, `work.skillGainPerDay` a day, up to the cap. */
function learnAtTheHelm(ctx: StepCtx, actor: Actor): void {
  if (!holdsTheHelm(ctx, actor)) return;
  const now = actor.skills.piloting ?? 0;
  if (now >= SKILL_CAP) return;
  const perTick =
    perDayToPerSecond(ctx.config, ctx.config.work.skillGainPerDay) / ctx.config.time.tickRate;
  actor.skills = { ...actor.skills, piloting: Math.min(SKILL_CAP, now + perTick) };
}

function holdDone(ctx: StepCtx, actor: Actor, step: StepOf<"hold">): boolean {
  const needs = ctx.config.needs;
  const onDuty = isOnDuty(actor.schedule, ctx.tick, ctx.config);
  switch (step.hold) {
    case "sleep": {
      const slept = ctx.tick - step.sinceTick >= dayTicks(ctx.config, needs.sleepDays);
      const rested = actor.needs.fatigue <= needs.wakeBelow;
      const shiftCalls = onDuty && actor.needs.fatigue < needs.seekThreshold;
      return slept && (rested || shiftCalls);
    }
    case "rest":
      return onDuty && actor.needs.comfort <= 0;
    case "socialize":
      return onDuty && actor.needs.social <= 0;
    case "staff":
      if (helmHoldDone(ctx, actor, step)) return true;
      learnAtTheHelm(ctx, actor);
      return false;
    case "gangway":
      return gangwayHoldDone(ctx, actor, step);
  }
}

/**
 * A `work` step by stage: recipes are equipment's, the helm's handover the watch's (D77), the
 * plot travel's (D78); the rest are personal timers.
 */
function runWork(ctx: StepCtx, deps: WorkDeps, actor: Actor, step: StepOf<"work">): StepResult {
  switch (step.stage) {
    case "recipe":
      return runRecipe(ctx, deps, actor);
    case "handover":
      return runHandover(ctx, actor, step);
    case "plot":
      return runPlot(ctx, actor, step);
    case "cook":
      return runCook(ctx, actor, step);
    case "mop":
      return runMop(ctx, actor, step);
    case "eat":
    case "buy":
    case "rounds":
      return countTick(step) ? "done" : "wait";
  }
}

export function runStep(
  ctx: StepCtx,
  deps: WorkDeps,
  actor: Actor,
  step: ActivityStep,
): StepResult {
  switch (step.kind) {
    case "moveTo":
      return runMove(ctx, actor, step);
    case "pickUp":
      return runPickUp(ctx, actor, step);
    case "work":
      return runWork(ctx, deps, actor, step);
    case "consume":
      return runConsume(ctx, actor, step);
    case "putDown":
      return runPutDown(ctx, actor, step);
    case "serve":
      return runServe(ctx, actor, step);
    case "buy":
      return runBuy(ctx, actor, step);
    case "throughGate":
      return runThroughGate(ctx, actor, step);
    case "stowBought":
      return runStowBought(ctx, actor, step);
    case "loadTruck":
      return runLoadTruck(ctx, actor, step);
    case "unloadTruck":
      return runUnloadTruck(ctx, actor, step);
    case "parkTruck":
      return runParkTruck(ctx, actor, step);
    case "awaitWord":
      return runAwaitWord(ctx, actor, step);
    case "talk":
      return runTalk(ctx, actor, step);
    case "deliverCard":
      // The tick it comes up the captain is still with them (the world halts on the card).
      if (heldCard(ctx.state, step.decisionId) === undefined) return "done";
      deliverHeldCard(ctx, step.decisionId, "met");
      return "wait";
    case "hold":
      return holdDone(ctx, actor, step) ? "done" : "wait";
  }
}
