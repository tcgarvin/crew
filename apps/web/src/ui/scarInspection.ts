/**
 * §hull-scars-and-ship-loss: the inspector's view of a hull scar (a tap on its tile) and the line a
 * room's inspection gives its scars. Read from the snapshot at the view tick, like the room and the
 * machine, so it agrees with the overlay on screen (D14).
 */
import type {
  CompartmentId,
  ContentBundle,
  DeepReadonly,
  HullScar,
  ScarId,
  WorldState,
} from "@crew/sim";
import { roomPhrase } from "@crew/sim";
import type { PlaceInspection } from "./placeInspection";

/** "8 hull points", "1 hull point"; fractions (a half-recovered odd charge) to one place. */
function points(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} hull point${rounded === 1 ? "" : "s"}`;
}

/** Whoever is patching or plating `scarId`, in their activity's words. */
function scarWorkers(state: DeepReadonly<WorldState>, scarId: ScarId): string[] {
  const words: string[] = [];
  for (const actor of Object.values(state.actors)) {
    const activity = actor.activity;
    if (activity.kind !== "task") continue;
    const task = state.work.tasks[activity.taskId];
    if (task?.target.kind !== "scar" || task.target.scarId !== scarId) continue;
    words.push(
      activity.label === undefined
        ? `${actor.name} is on it.`
        : `${actor.name} is ${activity.label}.`,
    );
  }
  return words;
}

function compartmentPhrase(
  state: DeepReadonly<WorldState>,
  content: ContentBundle,
  compartmentId: CompartmentId,
): string {
  const compartment = state.compartments[compartmentId];
  if (compartment === undefined) {
    throw new Error(`inspectScar: no compartment ${compartmentId}`);
  }
  const deck = content.decks[compartment.deckId];
  const def = deck?.compartments.find((c) => c.key === compartment.key);
  if (def === undefined) {
    throw new Error(`inspectScar: compartment ${compartment.key} is not on its deck`);
  }
  return roomPhrase(def);
}

function scarWords(scar: DeepReadonly<HullScar>, where: string): string {
  const rock = scar.rock === "large" ? "A large rock" : "A small rock";
  const hit = `${rock} holed ${where} here, costing ${points(scar.damage)}.`;
  if (!scar.patched) return `${hit} Not patched yet.`;
  const left = scar.damage - scar.recovered;
  return `${hit} A patch kit won back ${points(scar.recovered)}; ${points(left)} wait on plating at port.`;
}

/**
 * The scar `scarId` as an inspector place: "Hull scar", patched or unpatched, what hit it and what
 * it cost, and who is working on it. Throws when the snapshot has no such scar: the canvas only
 * selects scars it drew, and the frame and the snapshot are of the same tick.
 */
export function inspectScar(
  state: DeepReadonly<WorldState>,
  content: ContentBundle,
  scarId: ScarId,
): PlaceInspection {
  const scar = state.hull.scars.find((s) => s.id === scarId);
  if (scar === undefined) throw new Error(`inspectScar: no scar ${scarId} in the snapshot`);
  const words = [scarWords(scar, compartmentPhrase(state, content, scar.compartmentId))];
  words.push(...scarWorkers(state, scarId));
  return {
    title: "Hull scar",
    subtitle: scar.patched ? "patched" : "unpatched",
    text: words.join(" "),
  };
}

/**
 * A room's scars in one sentence ("Hull scars here: 3, 1 patched."), or `undefined` with none, for
 * the room's inspection.
 */
export function roomScarsLine(
  state: DeepReadonly<WorldState>,
  compartmentId: CompartmentId,
): string | undefined {
  const scars = state.hull.scars.filter((s) => s.compartmentId === compartmentId);
  if (scars.length === 0) return undefined;
  const patched = scars.filter((s) => s.patched).length;
  if (scars.length === 1) {
    return `A hull scar here, ${patched === 1 ? "patched" : "not patched yet"}.`;
  }
  return `Hull scars here: ${scars.length}, ${patched} patched.`;
}
