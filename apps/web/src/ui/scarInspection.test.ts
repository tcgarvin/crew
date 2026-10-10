/**
 * §hull-scars-and-ship-loss: a tapped hull scar, and a room's inspection listing its scars, read
 * from the snapshot.
 */
import type {
  ClaimId,
  FieldId,
  HullScar,
  LocalKey,
  ScarId,
  Task,
  TaskId,
  Tick,
  WorldState,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDeckLayout } from "../render/deckLayout";
import { newGame } from "../worker/testGame";
import { inspectRoom } from "./roomInspection";
import { inspectScar, roomScarsLine } from "./scarInspection";

const { bundle, world } = newGame(7);
const deckId = Object.keys(world.state.dirt.cells)[0];
const deck = deckId === undefined ? undefined : bundle.decks[deckId as keyof typeof bundle.decks];
if (deck === undefined) throw new Error("the world has a deck");
const layout = buildDeckLayout(deck, bundle);
const galley = deck.compartments.find((c) => c.tags.includes("galley"));
if (galley === undefined) throw new Error("the deck has a galley");
const galleyKey = galley.key as LocalKey;

function galleyId(state: WorldState) {
  const found = Object.values(state.compartments).find((c) => c.key === galleyKey);
  if (found === undefined) throw new Error("no galley compartment");
  return found.id;
}

/** A copy of the new game's state with `scars` in the galley. */
function withScars(...scars: Pick<HullScar, "id" | "rock" | "damage" | "recovered" | "patched">[]) {
  const state = structuredClone(world.state);
  for (const scar of scars) {
    state.hull.scars.push({
      ...scar,
      fieldId: "f1" as FieldId,
      tile: { x: 1, y: 1 },
      compartmentId: galleyId(state),
      tick: 10 as Tick,
    });
  }
  return state;
}

const open = {
  id: "r1" as ScarId,
  rock: "large",
  damage: 8,
  recovered: 0,
  patched: false,
} as const;
const patched = {
  id: "r2" as ScarId,
  rock: "small",
  damage: 3,
  recovered: 1.5,
  patched: true,
} as const;

describe("inspectScar", () => {
  it("names an unpatched scar, what hit it and what it cost", () => {
    const scar = inspectScar(withScars(open), bundle, open.id);
    expect(scar.title).toBe("Hull scar");
    expect(scar.subtitle).toBe("unpatched");
    expect(scar.text).toBe(
      `A large rock holed the ${galley.name.toLowerCase()} here, costing 8 hull points. Not patched yet.`,
    );
  });

  it("says what a patch won back and what waits on plating", () => {
    const scar = inspectScar(withScars(patched), bundle, patched.id);
    expect(scar.subtitle).toBe("patched");
    expect(scar.text).toMatch(
      /won back 1\.5 hull points; 1\.5 hull points wait on plating at port\.$/,
    );
  });

  it("says who is working on it", () => {
    const state = withScars(open);
    const actor = Object.values(state.actors)[0];
    if (actor === undefined) throw new Error("the world has crew");
    const taskId = "task:patch" as TaskId;
    state.work.tasks[taskId] = {
      id: taskId,
      type: "patchHull",
      target: { kind: "scar", scarId: open.id },
    } as unknown as Task;
    actor.activity = {
      kind: "task",
      taskId,
      claimId: "claim:patch" as ClaimId,
      urgency: "essential",
      action: { kind: "idle" },
      sinceTick: 0 as Tick,
      label: "patching the hull",
    } as unknown as typeof actor.activity;
    expect(inspectScar(state, bundle, open.id).text).toMatch(
      new RegExp(`${actor.name} is patching the hull\\.$`),
    );
  });

  it("throws for a scar the snapshot does not hold", () => {
    expect(() => inspectScar(withScars(), bundle, "r9" as ScarId)).toThrow(/no scar r9/);
  });
});

describe("a room's scars", () => {
  it("are left out with none", () => {
    const state = withScars();
    expect(roomScarsLine(state, galleyId(state))).toBeUndefined();
    expect(inspectRoom(state, bundle, layout, galleyKey).text).not.toMatch(/scar/);
  });

  it("are counted, with how many are patched", () => {
    const one = withScars(open);
    expect(roomScarsLine(one, galleyId(one))).toBe("A hull scar here, not patched yet.");
    const two = withScars(open, patched);
    expect(inspectRoom(two, bundle, layout, galleyKey).text).toMatch(
      /Hull scars here: 2, 1 patched\.$/,
    );
  });
});
