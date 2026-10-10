/**
 * Short present-tense verb labels for the canvas (PLAN §6: "per-actor action verb label").
 * The work system computes a label whenever an activity's step changes and stores it on
 * `activity.label`; `core/render.ts` shows it verbatim.
 *
 * Vocabulary: "idle", "walking", "walking to <place>", "going ashore", "walking on the dock",
 * "coming aboard" (§calling-the-crew-aboard), "picking up <item>", "hauling <item>",
 * "stowing <item>", "buying <item>" (§buying-parts), "ashore buying <item>" (§buying-parts),
 * "fetching the hand truck", "loading <item>", "hauling <n> crates", "unloading <item>", "returning
 * the hand truck", "parking the hand truck" (§hand-truck-trips), "eating", "asleep", "asleep in the
 * <cabin>" (§sleeping-places), "resting", "chatting", "inspecting <machine>", "servicing
 * <machine>", "fixing <machine>", "at the helm", "manning <machine>", the watch
 * (§who-has-the-helm): "going to the helm", "relieving <name> at the helm" (or "taking the helm"),
 * "leaving the helm" (the step off the seat), "on the gangway", "doing rounds", and "plotting a
 * course to <port>" (§course-plotting); and the captain ashore (§looking-for-work, `shoreLabel`):
 * "going ashore to look for work", "looking for work", "looking round the dock", "going to see
 * <name>", "talking with <name>", "ashore to see <name>"; the galley (§cooking-and-serving):
 * "fetching provisions", "cooking", "serving dinner", "taking a plate to the helm", "at the helm,
 * eating"; dirt (§mop-trips): "fetching the mop", "mopping <room>", "putting the mop away"; off
 * watch (slice 4, `recreationLabel`): the activity's `label` while playing ("playing cards"), its
 * `waitingLabel` while the session gathers, its `solo.label` after a collapse ("playing
 * solitaire"), "fetching the harmonica" / "fetching a book", "putting the harmonica away" /
 * "putting the book back"; a word in the cabin (`talkLabel`): "going to the captain's cabin" (or
 * "the first officer's cabin"), "having a word with <name>", "having a word with the captain".
 * Names are lower-cased content names; `<place>` is the destination compartment's name, or the
 * machine's name when the machine is in the actor's own compartment.
 */
import { roomPhrase } from "../../core/rooms";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { CompartmentId, ItemDefId, ItemId, MachineId } from "../../core/types/ids";
import type { DerivedCaches, ReadonlyWorldState } from "../../core/types/pipeline";
import type { ActivityStep, HoldKind, StepTarget, Task } from "../../core/types/work";
import { damageTaskLabel } from "../damage/labels";
import { reportLabel } from "../intercom/labels";
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

/** §naming-rooms: the room as a sentence names it ("the galley", "engineering"). */
function compartmentName(ctx: LabelCtx, compartmentId: CompartmentId): string {
  const compartment = ctx.state.compartments[compartmentId];
  if (compartment === undefined) return "somewhere";
  const def = ctx.content.decks[compartment.deckId]?.compartments.find(
    (c) => c.key === compartment.key,
  );
  return def === undefined ? `the ${lower(compartment.key, "room")}` : roomPhrase(def);
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
  // §living-on-the-dock: dock floor is in no compartment; say which way across the ramp the walk
  // goes.
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

/** §cooking-and-serving: is the actor carrying a served meal (a `meal`-tagged item)? */
function carryingMeal(ctx: LabelCtx, actor: DeepReadonly<Actor>): boolean {
  return Object.values(ctx.state.items).some(
    (item) =>
      item.location.kind === "carriedBy" &&
      item.location.actorId === actor.id &&
      ctx.content.items[item.defId]?.tags.includes("meal") === true,
  );
}

/** §mop-trips: "mopping the galley", from the task's room. */
function mopLabel(ctx: LabelCtx, task: DeepReadonly<Task> | undefined): string {
  if (task?.target.kind !== "compartment") return "mopping";
  return `mopping ${compartmentName(ctx, task.target.compartmentId)}`;
}

/**
 * §mop-trips: a mopper's step between tiles of the room they are mopping reads as mopping it, not
 * "walking to the cargo hold" from inside the hold.
 */
function mopWalkWithin(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  task: DeepReadonly<Task> | undefined,
  target: StepTarget,
): boolean {
  if (task?.type !== "cleanCompartment" || task.target.kind !== "compartment") return false;
  const location = actor.location;
  if (location.kind !== "onDeck" || "machineId" in target) return false;
  const geometry = ctx.caches.nav.decks[location.deckId];
  if (geometry === undefined) return false;
  const room = task.target.compartmentId;
  return (
    compartmentAt(geometry, location.x, location.y) === room &&
    compartmentAt(geometry, target.x + 0.5, target.y + 0.5) === room
  );
}

/** Is `task` a watch at the helm (a `staffStation` on a `pilotStation` machine)? */
function isHelmTask(ctx: LabelCtx, task: DeepReadonly<Task> | undefined): boolean {
  if (task?.type !== "staffStation" || task.target.kind !== "machine") return false;
  const machine = ctx.state.machines[task.target.machineId];
  const tags = machine === undefined ? [] : (ctx.content.machines[machine.defId]?.tags ?? []);
  return tags.includes("pilotStation");
}

/**
 * §handover: the handover step: "relieving Noor Haddad at the helm", or "taking the helm" if
 * empty.
 */
function handoverLabel(ctx: LabelCtx): string {
  const holder = whoHasTheHelm(ctx.state, ctx.content);
  const name = holder === undefined ? undefined : ctx.state.actors[holder]?.name;
  return name === undefined ? "taking the helm" : `relieving ${name} at the helm`;
}

/**
 * §course-plotting: "plotting a course to Kessler Drift", from the task's `courseToPlot`
 * problem.
 */
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
  // §cooking-and-serving: a plate on its way up to the helm.
  if (task?.type === "carryMeal" && step.kind === "moveTo" && carryingMeal(ctx, actor)) {
    return "taking a plate to the helm";
  }
  // §machine-damage, §scouts: damage work says what it is doing (`systems/damage/labels.ts`).
  if (
    task?.type === "repairDamage" ||
    task?.type === "patchHull" ||
    task?.type === "plateHull" ||
    task?.type === "checkCompartment"
  ) {
    return damageTaskLabel(ctx, actor, task, step);
  }
  switch (step.kind) {
    case "moveTo":
      if (isHelmTask(ctx, task)) return "going to the helm";
      if (mopWalkWithin(ctx, actor, task, step.target)) return mopLabel(ctx, task);
      return placeLabel(ctx, actor, step.target);
    case "pickUp":
      if (task?.type === "cookMeal") return "fetching provisions";
      if (task?.type === "cleanCompartment") return "fetching the mop";
      return `picking up ${itemName(ctx, step.itemId)}`;
    case "putDown":
      if (task?.type === "cleanCompartment") return "putting the mop away";
      return `stowing ${itemName(ctx, step.itemId)}`;
    case "serve":
      return "serving dinner";
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
      if (step.stage === "cook") return "cooking";
      if (step.stage === "mop") return mopLabel(ctx, task);
      if (task === undefined || task.target.kind !== "machine") return "working";
      const verb = RECIPE_VERB[task.derivationKey] ?? RECIPE_VERB[task.type] ?? "working on";
      return `${verb} ${machineName(ctx, task.target.machineId)}`;
    }
    case "hold": {
      if (task === undefined || task.target.kind !== "machine") return "on station";
      const machine = ctx.state.machines[task.target.machineId];
      const tags = machine === undefined ? [] : (ctx.content.machines[machine.defId]?.tags ?? []);
      if (tags.includes("pilotStation")) {
        // §cooking-and-serving: the stander's plate, eaten in the seat (`galley.helmMeal`).
        return ctx.state.galley.helmMeal?.actorId === actor.id
          ? "at the helm, eating"
          : "at the helm";
      }
      return `manning ${machineName(ctx, task.target.machineId)}`;
    }
    case "consume":
    case "awaitWord":
    case "talk":
    case "deliverCard":
    case "recreate":
    case "confer":
      return "working";
  }
}

const HOLD_LABEL: Readonly<Record<HoldKind, string>> = {
  sleep: "asleep",
  rest: "resting",
  socialize: "chatting",
  staff: "on station",
  gangway: "on the gangway",
  bridge: "holding the bridge",
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
    case "serve":
      return "serving dinner";
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
    case "recreate":
      return recreateLabel(ctx, step);
    case "confer":
      return conferLabel(ctx, actor);
  }
}

// ---------------------------------------------------------------------------------------------
// Off watch (slice 4)
// ---------------------------------------------------------------------------------------------

/**
 * The `recreate` step: the def's `label` while playing (solo, or the session started), its
 * `waitingLabel` while the session gathers, its `solo.label` once a group game is played alone.
 */
export function recreateLabel(
  ctx: LabelCtx,
  step: DeepReadonly<Extract<ActivityStep, { kind: "recreate" }>>,
): string {
  const def = ctx.content.activities[step.activityId];
  if (def === undefined) return "taking it easy";
  if (step.role === "solo") {
    return def.participants.min >= 2 && def.solo !== undefined ? def.solo.label : def.label;
  }
  const session =
    step.sessionId === undefined ? undefined : ctx.state.social.sessions[step.sessionId];
  return session?.startedTick === undefined ? def.waitingLabel : def.label;
}

/** "a book" for a `book`, else "the harmonica": what is fetched for, or put back after, a game. */
function recreationItem(ctx: LabelCtx, itemId: ItemId): { book: boolean; name: string } {
  const item = ctx.state.items[itemId];
  const def = item === undefined ? undefined : ctx.content.items[item.defId];
  return { book: def?.tags.includes("book") === true, name: itemName(ctx, itemId) };
}

/** A `recreate` activity's label: the fetch, the walk, the game, putting it back. */
function recreationLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  rest: readonly DeepReadonly<ActivityStep>[],
  step: DeepReadonly<ActivityStep>,
): string {
  const fetching = (itemId: ItemId): string => {
    const item = recreationItem(ctx, itemId);
    return item.book ? "fetching a book" : `fetching the ${item.name}`;
  };
  switch (step.kind) {
    case "moveTo": {
      const next = rest.find((s) => s.kind !== "moveTo");
      if (next?.kind === "pickUp") return fetching(next.itemId);
      return placeLabel(ctx, actor, step.target);
    }
    case "pickUp":
      return fetching(step.itemId);
    case "putDown": {
      const item = recreationItem(ctx, step.itemId);
      return item.book ? "putting the book back" : `putting the ${item.name} away`;
    }
    default:
      return personalStepLabel(ctx, actor, step);
  }
}

/** Whose cabin a pending talk is in, said from the caller's rank: "the captain's cabin". */
function talkCabinName(ctx: LabelCtx): string | undefined {
  const talk = ctx.state.social.privateTalk;
  if (talk === undefined) return undefined;
  const caller = ctx.state.actors[talk.captainId];
  return caller?.roleTags.includes("captain") === true
    ? "the captain's cabin"
    : "the first officer's cabin";
}

/** The `confer` step: "having a word with Priya Kessler" (the caller), "with the captain". */
function conferLabel(ctx: LabelCtx, actor: DeepReadonly<Actor>): string {
  const talk = ctx.state.social.privateTalk;
  if (talk === undefined) return "having a word";
  if (talk.captainId === actor.id) {
    const other = ctx.state.actors[talk.actorId]?.name;
    return other === undefined ? "having a word" : `having a word with ${other}`;
  }
  const caller = ctx.state.actors[talk.captainId];
  return caller?.roleTags.includes("captain") === true
    ? "having a word with the captain"
    : "having a word with the first officer";
}

/** A `privateTalk` activity's label: the walk to the cabin, then the word. */
function talkLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  step: DeepReadonly<ActivityStep>,
): string {
  if (step.kind === "moveTo") {
    const cabin = talkCabinName(ctx);
    return cabin === undefined ? placeLabel(ctx, actor, step.target) : `going to ${cabin}`;
  }
  return personalStepLabel(ctx, actor, step);
}

/**
 * §sleeping-places: "asleep in the captain's cabin" when the bed is in a `cabin`-tagged
 * compartment, else "asleep". Content gives people no pronouns, so the cabin is named rather than
 * "her cabin".
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
  return `${HOLD_LABEL.sleep} in ${roomPhrase(def)}`;
}

/**
 * §hand-truck-trips: a hand-truck trip's walks say what is on the truck: fetching it, pushing a
 * load, or taking it back aboard empty; its other steps are labelled as any task's.
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
    const task = ctx.state.work.tasks[activity.taskId];
    // §handover: the step off the seat once relieved (no hold left in the plan).
    const rest = activity.plan?.steps.slice(activity.plan.stepIndex) ?? [];
    if (step.kind === "moveTo" && isHelmTask(ctx, task) && !rest.some((s) => s.kind === "hold")) {
      return "leaving the helm";
    }
    return taskStepLabel(ctx, actor, task, step);
  }
  if (activity.activity === "lookForWork" || activity.activity === "meetSpeaker") {
    return shoreLabel(ctx, actor, activity.plan?.steps.slice(activity.plan.stepIndex) ?? [], step);
  }
  // §gangway-watch-and-rounds: a round reads as one activity, its walks between stops included.
  if (activity.activity === "rounds") return "doing rounds";
  if (activity.activity === "recreate") {
    return recreationLabel(
      ctx,
      actor,
      activity.plan?.steps.slice(activity.plan.stepIndex) ?? [],
      step,
    );
  }
  if (activity.activity === "privateTalk") return talkLabel(ctx, actor, step);
  // §reporting-damage: the walk to the panel and the report read as one activity.
  if (activity.activity === "report") return reportLabel(ctx, actor, step);
  return personalStepLabel(ctx, actor, step);
}

/** Who a meeting still ahead in `rest` (its `deliverCard`) is with, if any. */
function meetingWith(rest: readonly DeepReadonly<ActivityStep>[]): string | undefined {
  const deliver = rest.find((s) => s.kind === "deliverCard");
  return deliver?.kind === "deliverCard" ? deliver.withName : undefined;
}

/**
 * §looking-for-work: the captain ashore. "going ashore to look for work", "looking for work" (on
 * the dock, waiting for word), "looking round the dock", "going to see Fenwick Adair", "talking
 * with Fenwick Adair", "ashore to see Fenwick Adair" (through the gate), "looking round the port";
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
