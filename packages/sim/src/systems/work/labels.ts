/**
 * Short present-tense verb labels for the canvas (PLAN §6: "per-actor action verb label").
 * The work system computes a label whenever an activity's step changes and stores it on
 * `activity.label`; `core/render.ts` shows it verbatim.
 *
 * Vocabulary: "idle", "walking", "walking to <place>", "going ashore", "walking on the dock",
 * "coming aboard" (D61), "picking up <item>", "hauling <item>",
 * "stowing <item>", "buying <item>" (D47), "ashore buying <item>" (D63), "fetching the hand truck",
 * "loading <item>", "hauling <n> crates", "unloading <item>", "returning the hand truck",
 * "parking the hand truck" (D65), "eating", "asleep", "asleep in the <cabin>" (D74), "resting",
 * "chatting", "inspecting <machine>", "servicing <machine>", "fixing <machine>", "at the helm", "manning <machine>",
 * the watch (D77): "going to the helm", "relieving <name> at the helm" (or "taking the helm"),
 * "on the gangway", "doing rounds", and "plotting a course to <port>" (D78); and the captain
 * ashore (D70, `shoreLabel`): "going ashore to look for work", "looking for work", "looking round
 * the dock", "going to see <name>", "talking with <name>", "ashore to see <name>". Names are
 * lower-cased content names; `<place>` is the destination compartment's name, or the machine's
 * name when the machine is in the actor's own compartment.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { CompartmentId, ItemDefId, ItemId, MachineId } from "../../core/types/ids";
import type { DerivedCaches, ReadonlyWorldState } from "../../core/types/pipeline";
import type { ActivityStep, HoldKind, StepTarget, Task } from "../../core/types/work";
import { compartmentAt, isDockTile } from "../spatial/geometry";
import { whoHasTheHelm } from "../watch/helm";
import { currentStep } from "./activity";

export interface LabelCtx {
  readonly state: ReadonlyWorldState;
  readonly content: ContentBundle;
  readonly caches: DerivedCaches;
}

const lower = (name: string | undefined, fallback: string): string =>
  (name ?? fallback).toLowerCase();

export function itemName(ctx: LabelCtx, itemId: ItemId): string {
  const item = ctx.state.items[itemId];
  return lower(item === undefined ? undefined : ctx.content.items[item.defId]?.name, "item");
}

export function itemDefName(ctx: LabelCtx, itemDefId: ItemDefId): string {
  return lower(
    (ctx.content.items[itemDefId] ?? ctx.state.defs.dynamic.items[itemDefId])?.name,
    "parts",
  );
}

export function machineName(ctx: LabelCtx, machineId: MachineId): string {
  const machine = ctx.state.machines[machineId];
  return lower(
    machine === undefined ? undefined : ctx.content.machines[machine.defId]?.name,
    "machine",
  );
}

function compartmentName(ctx: LabelCtx, compartmentId: CompartmentId): string {
  const compartment = ctx.state.compartments[compartmentId];
  if (compartment === undefined) return "somewhere";
  const deck = ctx.content.decks[compartment.deckId];
  return lower(deck?.compartments.find((c) => c.key === compartment.key)?.name, compartment.key);
}

function targetTile(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  target: StepTarget,
): TileCoord | undefined {
  if (!("machineId" in target)) return target;
  if (actor.location.kind !== "onDeck") return undefined;
  const geometry = ctx.caches.nav.decks[actor.location.deckId];
  return geometry?.interactionPositions.find(
    (p) => p.machineId === target.machineId && p.key === target.positionKey,
  )?.tile;
}

function placeLabel(ctx: LabelCtx, actor: DeepReadonly<Actor>, target: StepTarget): string {
  const location = actor.location;
  const tile = targetTile(ctx, actor, target);
  if (location.kind !== "onDeck" || tile === undefined) return "walking";
  const geometry = ctx.caches.nav.decks[location.deckId];
  if (geometry === undefined) return "walking";
  // D61: dock floor is in no compartment; say which way across the ramp the walk goes.
  const toDock = isDockTile(geometry, tile.x, tile.y);
  const onDock = isDockTile(geometry, location.x, location.y);
  if (toDock) return onDock ? "walking on the dock" : "going ashore";
  if (onDock) return "coming aboard";
  const to = compartmentAt(geometry, tile.x + 0.5, tile.y + 0.5);
  const here = compartmentAt(geometry, location.x, location.y);
  if ("machineId" in target && to === here)
    return `walking to the ${machineName(ctx, target.machineId)}`;
  return to === undefined ? "walking" : `walking to ${compartmentName(ctx, to)}`;
}

function carrying(ctx: LabelCtx, actor: DeepReadonly<Actor>, itemId: ItemId): boolean {
  const location = ctx.state.items[itemId]?.location;
  return location?.kind === "carriedBy" && location.actorId === actor.id;
}

/** What a `buyParts` task is buying, for its labels ("parts" for anything else). */
function marketItemName(ctx: LabelCtx, task: DeepReadonly<Task> | undefined): string {
  const ref = task?.progressRef;
  return ref?.kind === "market" ? itemDefName(ctx, ref.itemDefId) : "parts";
}

const RECIPE_VERB: Readonly<Record<string, string>> = {
  inspect: "inspecting",
  maintain: "servicing",
  repair: "fixing",
};

/** Is `task` a watch at the helm (a `staffStation` on a `pilotStation` machine)? */
function isHelmTask(ctx: LabelCtx, task: DeepReadonly<Task> | undefined): boolean {
  if (task?.type !== "staffStation" || task.target.kind !== "machine") return false;
  const machine = ctx.state.machines[task.target.machineId];
  const tags = machine === undefined ? [] : (ctx.content.machines[machine.defId]?.tags ?? []);
  return tags.includes("pilotStation");
}

/** D77: the handover step: "relieving Noor Haddad at the helm", or "taking the helm" if empty. */
function handoverLabel(ctx: LabelCtx): string {
  const holder = whoHasTheHelm(ctx.state, ctx.content);
  const name = holder === undefined ? undefined : ctx.state.actors[holder]?.name;
  return name === undefined ? "taking the helm" : `relieving ${name} at the helm`;
}

/** D78: "plotting a course to Kessler Drift", from the task's `courseToPlot` problem. */
function plotLabel(ctx: LabelCtx, task: DeepReadonly<Task> | undefined): string {
  const problem = task === undefined ? undefined : ctx.state.work.problems[task.problemId];
  if (problem?.kind !== "courseToPlot") return "plotting a course";
  const port = ctx.content.ports[problem.payload.toPortId]?.name ?? problem.payload.toPortId;
  return `plotting a course to ${port}`;
}

function taskStepLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  task: DeepReadonly<Task> | undefined,
  step: DeepReadonly<ActivityStep>,
): string {
  if (
    task?.type === "haul" &&
    task.target.kind === "item" &&
    carrying(ctx, actor, task.target.itemId)
  ) {
    return step.kind === "putDown"
      ? `stowing ${itemName(ctx, task.target.itemId)}`
      : `hauling ${itemName(ctx, task.target.itemId)}`;
  }
  switch (step.kind) {
    case "moveTo":
      return isHelmTask(ctx, task) ? "going to the helm" : placeLabel(ctx, actor, step.target);
    case "pickUp":
      return `picking up ${itemName(ctx, step.itemId)}`;
    case "putDown":
      return `stowing ${itemName(ctx, step.itemId)}`;
    case "buy":
      return `buying ${itemDefName(ctx, step.itemDefId)}`;
    case "throughGate":
      return `ashore buying ${marketItemName(ctx, task)}`;
    case "stowBought":
      return `stowing ${itemDefName(ctx, step.itemDefId)}`;
    case "loadTruck":
      return `loading ${itemName(ctx, step.itemId)}`;
    case "unloadTruck":
      return `unloading ${itemName(ctx, step.itemId)}`;
    case "parkTruck":
      return "parking the hand truck";
    case "work": {
      if (step.stage === "buy") return `buying ${marketItemName(ctx, task)}`;
      if (step.stage === "handover") return handoverLabel(ctx);
      if (step.stage === "plot") return plotLabel(ctx, task);
      if (step.stage === "rounds") return "doing rounds";
      if (task === undefined || task.target.kind !== "machine") return "working";
      const verb = RECIPE_VERB[task.derivationKey] ?? RECIPE_VERB[task.type] ?? "working on";
      return `${verb} ${machineName(ctx, task.target.machineId)}`;
    }
    case "hold": {
      if (task === undefined || task.target.kind !== "machine") return "on station";
      const machine = ctx.state.machines[task.target.machineId];
      const tags = machine === undefined ? [] : (ctx.content.machines[machine.defId]?.tags ?? []);
      return tags.includes("pilotStation")
        ? "at the helm"
        : `manning ${machineName(ctx, task.target.machineId)}`;
    }
    case "consume":
    case "awaitWord":
    case "talk":
    case "deliverCard":
      return "working";
  }
}

const HOLD_LABEL: Readonly<Record<HoldKind, string>> = {
  sleep: "asleep",
  rest: "resting",
  socialize: "chatting",
  staff: "on station",
  gangway: "on the gangway",
};

function personalStepLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  step: DeepReadonly<ActivityStep>,
): string {
  switch (step.kind) {
    case "moveTo":
      return placeLabel(ctx, actor, step.target);
    case "pickUp":
      return `picking up ${itemName(ctx, step.itemId)}`;
    case "putDown":
      return `putting down ${itemName(ctx, step.itemId)}`;
    case "work":
      return step.stage === "rounds" ? "doing rounds" : "eating";
    case "consume":
      return "eating";
    case "buy":
    case "throughGate":
      return "buying";
    case "stowBought":
      return `putting down ${itemDefName(ctx, step.itemDefId)}`;
    case "loadTruck":
    case "unloadTruck":
    case "parkTruck":
      return "moving crates";
    case "hold":
      return step.hold === "sleep" ? sleepLabel(ctx, actor) : HOLD_LABEL[step.hold];
    case "awaitWord":
      return "looking for work";
    case "talk":
      return `talking with ${step.withName}`;
    case "deliverCard":
      return "talking";
  }
}

/**
 * D74: "asleep in the captain's cabin" when the bed is in a `cabin`-tagged compartment, else
 * "asleep". Content gives people no pronouns, so the cabin is named rather than "her cabin".
 */
function sleepLabel(ctx: LabelCtx, actor: DeepReadonly<Actor>): string {
  const location = actor.location;
  if (location.kind !== "onDeck") return HOLD_LABEL.sleep;
  const geometry = ctx.caches.nav.decks[location.deckId];
  const compartmentId =
    geometry === undefined ? undefined : compartmentAt(geometry, location.x, location.y);
  const compartment =
    compartmentId === undefined ? undefined : ctx.state.compartments[compartmentId];
  const def = ctx.content.decks[location.deckId]?.compartments.find(
    (c) => c.key === compartment?.key,
  );
  if (def === undefined || !def.tags.includes("cabin")) return HOLD_LABEL.sleep;
  return `${HOLD_LABEL.sleep} in the ${def.name.toLowerCase()}`;
}

/**
 * D65: a hand-truck trip's walks say what is on the truck: fetching it, pushing a load, or taking
 * it back aboard empty; its other steps are labelled as any task's.
 */
function truckWalkLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  truckId: ItemId,
  steps: readonly DeepReadonly<ActivityStep>[],
  target: StepTarget,
): string {
  if (!carrying(ctx, actor, truckId)) return "fetching the hand truck";
  const load = Object.values(ctx.state.items).filter(
    (i) => i.location.kind === "inContainer" && i.location.containerId === truckId,
  );
  const [only] = load;
  if (load.length === 1 && only !== undefined) return `hauling ${itemName(ctx, only.id)}`;
  if (load.length > 1) return `hauling ${load.length} crates`;
  const loadingLeft = steps.some((s) => s.kind === "loadTruck");
  return loadingLeft ? placeLabel(ctx, actor, target) : "returning the hand truck";
}

/** The label for an actor's current activity and step. */
export function labelFor(ctx: LabelCtx, actor: DeepReadonly<Actor>): string {
  const activity = actor.activity;
  if (activity.kind === "idle") return actor.movement.kind === "moving" ? "walking" : "idle";
  const step = currentStep(activity);
  if (step === undefined) return "idle";
  if (activity.kind === "task") {
    const haul = activity.haul;
    if (haul !== undefined && step.kind === "moveTo" && activity.plan !== undefined) {
      const rest = activity.plan.steps.slice(activity.plan.stepIndex);
      return truckWalkLabel(ctx, actor, haul.truckId, rest, step.target);
    }
    return taskStepLabel(ctx, actor, ctx.state.work.tasks[activity.taskId], step);
  }
  if (activity.activity === "lookForWork" || activity.activity === "meetSpeaker") {
    return shoreLabel(ctx, actor, activity.plan?.steps.slice(activity.plan.stepIndex) ?? [], step);
  }
  // D77: a round reads as one activity, its walks between stops included.
  if (activity.activity === "rounds") return "doing rounds";
  return personalStepLabel(ctx, actor, step);
}

/** Who a meeting still ahead in `rest` (its `deliverCard`) is with, if any. */
function meetingWith(rest: readonly DeepReadonly<ActivityStep>[]): string | undefined {
  const deliver = rest.find((s) => s.kind === "deliverCard");
  return deliver?.kind === "deliverCard" ? deliver.withName : undefined;
}

/**
 * D70: the captain ashore. "going ashore to look for work", "looking for work" (on the dock,
 * waiting for word), "looking round the dock", "going to see Fenwick Adair", "talking with
 * Fenwick Adair", "ashore to see Fenwick Adair" (through the gate), "looking round the port";
 * the walk back aboard is "coming aboard".
 */
function shoreLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  rest: readonly DeepReadonly<ActivityStep>[],
  step: DeepReadonly<ActivityStep>,
): string {
  const seeing = meetingWith(rest);
  switch (step.kind) {
    case "awaitWord":
      return "looking for work";
    case "talk":
      return `talking with ${step.withName}`;
    case "deliverCard":
      return `talking with ${step.withName}`;
    case "throughGate":
      return seeing === undefined ? "looking round the port" : `ashore to see ${seeing}`;
    case "moveTo": {
      if (seeing !== undefined) return `going to see ${seeing}`;
      if (rest.some((s) => s.kind === "awaitWord")) return "going ashore to look for work";
      const place = placeLabel(ctx, actor, step.target);
      return place === "walking on the dock" ? "looking round the dock" : place;
    }
    default:
      return personalStepLabel(ctx, actor, step);
  }
}
