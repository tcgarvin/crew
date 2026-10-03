/**
 * Short present-tense verb labels for the canvas (PLAN §6: "per-actor action verb label").
 * The work system computes a label whenever an activity's step changes and stores it on
 * `activity.label`; `core/render.ts` shows it verbatim.
 *
 * Vocabulary: "idle", "walking", "walking to <place>", "going ashore", "walking on the dock",
 * "coming aboard" (D61), "picking up <item>", "hauling <item>",
 * "stowing <item>", "buying <item>" (D47), "ashore buying <item>" (D63), "eating", "asleep", "resting", "chatting", "inspecting <machine>",
 * "servicing <machine>", "fixing <machine>", "at the helm", "manning <machine>". Names are
 * lower-cased content names; `<place>` is the destination compartment's name, or the machine's
 * name when the machine is in the actor's own compartment.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { CompartmentId, ItemDefId, ItemId, MachineId } from "../../core/types/ids";
import type { DerivedCaches, ReadonlyWorldState } from "../../core/types/pipeline";
import type { ActivityStep, StepTarget, Task } from "../../core/types/work";
import { compartmentAt, isDockTile } from "../spatial/geometry";
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
      return placeLabel(ctx, actor, step.target);
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
    case "work": {
      if (step.stage === "buy") return `buying ${marketItemName(ctx, task)}`;
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
      return "working";
  }
}

const HOLD_LABEL = { sleep: "asleep", rest: "resting", socialize: "chatting", staff: "on station" };

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
    case "consume":
      return "eating";
    case "buy":
    case "throughGate":
      return "buying";
    case "stowBought":
      return `putting down ${itemDefName(ctx, step.itemDefId)}`;
    case "hold":
      return HOLD_LABEL[step.hold];
  }
}

/** The label for an actor's current activity and step. */
export function labelFor(ctx: LabelCtx, actor: DeepReadonly<Actor>): string {
  const activity = actor.activity;
  if (activity.kind === "idle") return actor.movement.kind === "moving" ? "walking" : "idle";
  const step = currentStep(activity);
  if (step === undefined) return "idle";
  if (activity.kind === "task") {
    return taskStepLabel(ctx, actor, ctx.state.work.tasks[activity.taskId], step);
  }
  return personalStepLabel(ctx, actor, step);
}
