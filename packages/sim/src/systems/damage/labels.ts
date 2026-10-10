import { roomPhrase } from "../../core/rooms";
/**
 * Labels for damage work (§machine-damage, §scouts), read by `systems/work/labels.ts`: "patching
 * the hull in the hold", "plating the hull in the hold", "fetching a patch kit", "fetching hull
 * plating", "fetching the welder torch", "repairing impact damage to the galley stove", "checking
 * the hold" (the scout's walk there and the look round alike), and "walking to the hold" on the way
 * to a scar or a machine. "holding the bridge" is the work system's hold label.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { CompartmentId, ItemId } from "../../core/types/ids";
import type { ActivityStep, Task } from "../../core/types/work";
import { compartmentAt } from "../spatial/geometry";
import { type LabelCtx, itemName, machineName } from "../work/labels";

function roomName(ctx: LabelCtx, compartmentId: CompartmentId | undefined): string {
  const compartment =
    compartmentId === undefined ? undefined : ctx.state.compartments[compartmentId];
  if (compartment === undefined) return "somewhere";
  const def = ctx.content.decks[compartment.deckId]?.compartments.find(
    (c) => c.key === compartment.key,
  );
  return def === undefined ? `the ${compartment.key.toLowerCase()}` : roomPhrase(def);
}

/** The room a damage task is about: the scar's, the machine's, or the one to check. */
function taskRoom(ctx: LabelCtx, task: DeepReadonly<Task>): CompartmentId | undefined {
  const target = task.target;
  if (target.kind === "compartment") return target.compartmentId;
  if (target.kind === "scar") {
    return ctx.state.hull.scars.find((s) => s.id === target.scarId)?.compartmentId;
  }
  if (target.kind === "machine") {
    const machine = ctx.state.machines[target.machineId];
    if (machine === undefined) return undefined;
    const placement = ctx.content.decks[machine.deckId]?.machines.find(
      (p) => p.key === machine.placementKey,
    );
    const geometry = ctx.caches.nav.decks[machine.deckId];
    if (placement === undefined || geometry === undefined) return undefined;
    return compartmentAt(geometry, placement.origin.x, placement.origin.y);
  }
  return undefined;
}

function fetchLabel(ctx: LabelCtx, itemId: ItemId): string {
  const item = ctx.state.items[itemId];
  const tags = item === undefined ? [] : (ctx.content.items[item.defId]?.tags ?? []);
  if (tags.includes("patchKit")) return "fetching a patch kit";
  if (tags.includes("plating")) return "fetching hull plating";
  return `fetching the ${itemName(ctx, itemId)}`;
}

function workLabel(ctx: LabelCtx, task: DeepReadonly<Task>, room: string): string {
  switch (task.type) {
    case "patchHull":
      return `patching the hull in ${room}`;
    case "plateHull":
      return `plating the hull in ${room}`;
    case "checkCompartment":
      return `checking ${room}`;
    default:
      return task.target.kind === "machine"
        ? `repairing impact damage to the ${machineName(ctx, task.target.machineId)}`
        : "repairing impact damage";
  }
}

export function damageTaskLabel(
  ctx: LabelCtx,
  _actor: DeepReadonly<Actor>,
  task: DeepReadonly<Task>,
  step: DeepReadonly<ActivityStep>,
): string {
  const room = roomName(ctx, taskRoom(ctx, task));
  if (step.kind === "pickUp") return fetchLabel(ctx, step.itemId);
  if (step.kind === "moveTo" && task.type !== "checkCompartment") return `walking to ${room}`;
  return workLabel(ctx, task, room);
}
