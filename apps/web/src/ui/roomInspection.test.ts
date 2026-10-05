/** D82: the room inspector reads the snapshot's dirt grid, tiers and who holds the mop task. */
import type { ClaimId, LocalKey, Task, TaskId, Tick, WorldState } from "@crew/sim";
import { roomCells } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDeckLayout } from "../render/deckLayout";
import { newGame } from "../worker/testGame";
import { inspectRoom, roomMoppers } from "./roomInspection";

const { bundle, world } = newGame(7);
const deckId = Object.keys(world.state.dirt.cells)[0];
const deck = deckId === undefined ? undefined : bundle.decks[deckId as keyof typeof bundle.decks];
if (deck === undefined) throw new Error("the world has a deck");
const layout = buildDeckLayout(deck, bundle);
const galley = deck.compartments.find((c) => c.tags.includes("galley"));
if (galley === undefined) throw new Error("the deck has a galley");
const galleyKey = galley.key as LocalKey;

/** A copy of the new game's state, so each case dirties its own. */
function snapshot(): WorldState {
  return structuredClone(world.state);
}

function compartmentIdOf(state: WorldState, key: string) {
  const found = Object.values(state.compartments).find((c) => c.key === key);
  if (found === undefined) throw new Error(`no compartment ${key}`);
  return found.id;
}

/** Give the first crew member the galley's cleaning task, with `label` on their activity. */
function mopTheGalley(state: WorldState, label: string): string {
  const actor = Object.values(state.actors)[0];
  if (actor === undefined) throw new Error("the world has crew");
  const taskId = "task:mop" as TaskId;
  state.work.tasks[taskId] = {
    id: taskId,
    type: "cleanCompartment",
    target: { kind: "compartment", compartmentId: compartmentIdOf(state, galleyKey) },
  } as unknown as Task;
  actor.activity = {
    kind: "task",
    taskId,
    claimId: "claim:mop" as ClaimId,
    urgency: "routine",
    action: { kind: "idle" },
    sinceTick: 0 as Tick,
    label,
  } as unknown as typeof actor.activity;
  return actor.name;
}

describe("inspectRoom", () => {
  it("names a clean room, with a clean floor, before the dirt system has tiered it", () => {
    const state = snapshot();
    const room = inspectRoom(state, bundle, layout, galleyKey);
    expect(room.title).toBe(galley.name);
    expect(room.subtitle).toBe("clean");
    expect(room.text).toBe("Floor 0% dirty on average, 0% at the worst spot.");
  });

  it("gives the tier and the mean and worst cell of the room's floor", () => {
    const state = snapshot();
    const row = state.dirt.cells[deck.id];
    if (row === undefined) throw new Error("the deck has a dirt row");
    const cells = roomCells(deck, galleyKey);
    // Every tile at 51 (20%), one at 255: the worst spot and a raised mean.
    for (const index of cells) row[index] = 51;
    const first = cells[0];
    if (first === undefined) throw new Error("the galley has floor");
    row[first] = 255;
    state.dirt.tiers[galleyKey] = "dirty";
    const mean = Math.round(((51 * (cells.length - 1) + 255) / cells.length / 255) * 100);
    const room = inspectRoom(state, bundle, layout, galleyKey);
    expect(room.subtitle).toBe("dirty");
    expect(room.text).toBe(`Floor ${mean}% dirty on average, 100% at the worst spot.`);
  });

  it("ignores dirt in other rooms", () => {
    const state = snapshot();
    const row = state.dirt.cells[deck.id];
    if (row === undefined) throw new Error("the deck has a dirt row");
    const galleyCells = new Set(roomCells(deck, galleyKey));
    row.forEach((_, i) => {
      if (!galleyCells.has(i)) row[i] = 200;
    });
    expect(inspectRoom(state, bundle, layout, galleyKey).text).toMatch(/^Floor 0% .* 0% at/);
  });

  it("says who is mopping it, in their activity's words", () => {
    const state = snapshot();
    state.dirt.tiers[galleyKey] = "filthy";
    const name = mopTheGalley(state, "mopping the galley");
    const room = inspectRoom(state, bundle, layout, galleyKey);
    expect(room.subtitle).toBe("filthy");
    expect(room.text).toMatch(new RegExp(`${name} is mopping the galley\\.$`));
    // Another room is not theirs.
    const other = deck.compartments.find((c) => c.key !== galleyKey);
    if (other === undefined) throw new Error("the deck has another room");
    expect(roomMoppers(state, layout, other.key)).toEqual([]);
  });

  it("throws on a room the deck does not have, or a snapshot without its dirt row", () => {
    const state = snapshot();
    expect(() => inspectRoom(state, bundle, layout, "nowhere")).toThrow(/no room/);
    delete state.dirt.cells[deck.id];
    expect(() => inspectRoom(state, bundle, layout, galleyKey)).toThrow(/no dirt grid/);
  });
});
