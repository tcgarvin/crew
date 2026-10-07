/**
 * D82 (ship-life slice 3 call 15): the inspector's view of a room, from a tap on its bare floor.
 * Read from the snapshot at the view tick, as the machine inspector is, so it agrees with the tint
 * on screen and never shows the run-ahead state (D14): the room's name, its tier, how dirty its
 * floor is on average and at the worst spot, who is mopping it, and (D93) its hull scars.
 */
import {
  type ActorId,
  type ContentBundle,
  type DeepReadonly,
  type LocalKey,
  type WorldState,
  roomCells,
} from "@crew/sim";
import type { DeckLayout } from "../render/deckLayout";
import type { PlaceInspection } from "./placeInspection";
import { roomScarsLine } from "./scarInspection";

/** Someone holding the room's cleaning task, and what their label says they are doing. */
export interface RoomMopper {
  readonly actorId: ActorId;
  readonly name: string;
  readonly label: string | undefined;
}

/** A cell (0..255) as a whole percentage. */
function percent(cell: number): number {
  return Math.round((cell / 255) * 100);
}

/** Everyone whose current task is cleaning room `key` on `layout`'s deck. */
export function roomMoppers(
  state: DeepReadonly<WorldState>,
  layout: Pick<DeckLayout, "deckId">,
  key: string,
): RoomMopper[] {
  const compartment = Object.values(state.compartments).find(
    (c) => c.deckId === layout.deckId && c.key === key,
  );
  if (compartment === undefined) {
    throw new Error(`inspectRoom: no compartment "${key}" on deck ${layout.deckId}`);
  }
  const moppers: RoomMopper[] = [];
  for (const actor of Object.values(state.actors)) {
    const activity = actor.activity;
    if (activity.kind !== "task") continue;
    const task = state.work.tasks[activity.taskId];
    if (task?.type !== "cleanCompartment" || task.target.kind !== "compartment") continue;
    if (task.target.compartmentId !== compartment.id) continue;
    moppers.push({ actorId: actor.id, name: actor.name, label: activity.label });
  }
  return moppers;
}

function mopperWords(moppers: readonly RoomMopper[]): string {
  return moppers
    .map((m) => (m.label === undefined ? `${m.name} is on it.` : `${m.name} is ${m.label}.`))
    .join(" ");
}

/**
 * The room `key` of `layout`'s deck as an inspector place. Throws when the key is not a room of
 * that deck or the snapshot has no dirt row for it: the canvas only selects rooms it drew, and
 * every deck in a world has its row (`core/invariants.ts`).
 */
export function inspectRoom(
  state: DeepReadonly<WorldState>,
  content: ContentBundle,
  layout: Pick<DeckLayout, "deckId" | "compartmentNames">,
  key: string,
): PlaceInspection {
  const name = layout.compartmentNames[key];
  const deck = content.decks[layout.deckId];
  if (name === undefined || deck === undefined) {
    throw new Error(`inspectRoom: no room "${key}" on deck ${layout.deckId}`);
  }
  const row = state.dirt.cells[layout.deckId];
  if (row === undefined || row.length !== deck.width * deck.height) {
    throw new Error(`inspectRoom: the snapshot has no dirt grid for deck ${layout.deckId}`);
  }
  const indexes = roomCells(deck, key as LocalKey);
  if (indexes.length === 0) throw new Error(`inspectRoom: room "${key}" has no floor`);
  let sum = 0;
  let worst = 0;
  for (const index of indexes) {
    const cell = row[index] ?? 0;
    sum += cell;
    worst = Math.max(worst, cell);
  }
  // A room the dirt system has not yet tiered has never risen past clean.
  const tier = state.dirt.tiers[key as LocalKey] ?? "clean";
  const grime = `Floor ${percent(sum / indexes.length)}% dirty on average, ${percent(worst)}% at the worst spot.`;
  const moppers = roomMoppers(state, layout, key);
  const compartment = Object.values(state.compartments).find(
    (c) => c.deckId === layout.deckId && c.key === key,
  );
  const scars = compartment === undefined ? undefined : roomScarsLine(state, compartment.id);
  const words = [grime];
  if (moppers.length > 0) words.push(mopperWords(moppers));
  if (scars !== undefined) words.push(scars);
  return { title: name, subtitle: tier, text: words.join(" ") };
}
