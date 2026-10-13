/**
 * Mopping (§mop-trips) on the dirt fixture with the planner: who mops which room, a full trip
 * (fetch the mop, the dirty tiles nearest first, the mop back in the locker, `roomCleaned`), and
 * cleaning against rounds on and off duty.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import { actionLabel } from "../../core/render";
import type { TileCoord } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import type { Item } from "../../core/types/ship";
import type { Task } from "../../core/types/work";
import { crewConfig } from "../work/fixtures/crew-deck";
import { eventsOf, run } from "../work/fixtures/run";
import {
  BETTINA,
  DIRT_DECK,
  JON,
  LOCKER_TILE,
  MARA,
  PRIYA,
  cellAt,
  dirtWorld,
  placeAt,
  soil,
} from "./fixtures/dirt-deck";

/** Hold tiles soiled for the tests, dirtiest first (row 6 east of the ramps' tops). */
const HOLD_SPOTS: readonly TileCoord[] = [
  { x: 4, y: 6 },
  { x: 6, y: 6 },
  { x: 8, y: 6 },
  { x: 5, y: 5 },
  { x: 7, y: 5 },
  { x: 3, y: 5 },
];
const GALLEY_SPOTS: readonly TileCoord[] = [
  { x: 5, y: 2 },
  { x: 6, y: 3 },
  { x: 7, y: 2 },
  { x: 4, y: 3 },
];
const ENGINEERING_SPOTS: readonly TileCoord[] = [
  { x: 8, y: 2 },
  { x: 9, y: 3 },
  { x: 8, y: 4 },
  { x: 11, y: 0 },
];

/** Soil spots with a falling gradient so the dirtiest-first order is known. */
function soilSpots(test: TestWorld, spots: readonly TileCoord[]): void {
  spots.forEach((tile, i) => soil(test, [tile], 250 - 10 * i));
}

function mop(test: TestWorld): Item {
  const found = Object.values(test.world.state.items).find((i) => i.defId === DIRT_DECK.mop);
  if (found === undefined) throw new Error("no mop");
  return found;
}

/** The cleaning task an actor is on now, if any. */
function cleaningTaskOf(test: TestWorld, actorId: ActorId): Task | undefined {
  const activity = test.world.state.actors[actorId]?.activity;
  if (activity?.kind !== "task") return undefined;
  const task = test.world.state.work.tasks[activity.taskId];
  return task?.type === "cleanCompartment" ? task : undefined;
}

/** Who took a cleaning task during `ticks`, in the order they first did. */
function moppers(test: TestWorld, ticks: number): ActorId[] {
  const seen: ActorId[] = [];
  for (let i = 0; i < ticks; i++) {
    run(test, 1);
    for (const id of Object.keys(test.world.state.actors) as ActorId[]) {
      if (cleaningTaskOf(test, id) !== undefined && !seen.includes(id)) seen.push(id);
    }
  }
  return seen;
}

describe("a mopping trip (§mop-trips)", () => {
  it("the deckhand fetches the mop, works the dirty tiles nearest first, puts it back; roomCleaned", () => {
    const test = dirtWorld();
    soilSpots(test, HOLD_SPOTS);
    const order: TileCoord[] = [];
    let carriedWhileMopping = true;
    const log = run(test, 3000, (world) => {
      const actor = world.state.actors[JON];
      const plan = actor?.activity.kind === "task" ? actor.activity.plan : undefined;
      const step = plan?.steps[plan.stepIndex];
      if (step?.kind === "work" && step.stage === "mop" && step.ticksNeeded > 0) {
        const held = mop(test).location;
        if (held.kind !== "carriedBy" || held.actorId !== JON) carriedWhileMopping = false;
        if (actor?.location.kind === "onDeck") {
          const tile = { x: Math.floor(actor.location.x), y: Math.floor(actor.location.y) };
          const last = order[order.length - 1];
          if (last === undefined || last.x !== tile.x || last.y !== tile.y) order.push(tile);
        }
      }
      return resolvedDirtProblems(world).length > 0;
    });
    const cleaned = eventsOf(log, "roomCleaned");
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]?.payload).toMatchObject({ key: "hall", byActorId: JON });
    expect(test.world.state.actors[JON]?.thoughts.map((t) => t.key)).toContain("squaredAway");
    // One trip over every soiled tile, walked nearest first from the locker at (11,5) (the
    // tuning commit: a dirtiest-first trip zigzagged the room), with the mop in hand.
    expect(order).toEqual([
      { x: 8, y: 6 },
      { x: 7, y: 5 },
      { x: 6, y: 6 },
      { x: 5, y: 5 },
      { x: 4, y: 6 },
      { x: 3, y: 5 },
    ]);
    expect(carriedWhileMopping).toBe(true);
    // Mopped to nothing, bar the odd footstep since.
    for (const t of HOLD_SPOTS) expect(cellAt(test, t)).toBeLessThan(10);
    expect(log.labels[JON]).toContain("mopping the corridor");
    // The mop is back in the locker, on the floor.
    expect(mop(test).location).toMatchObject({
      kind: "onDeck",
      x: LOCKER_TILE.x + 0.5,
      y: LOCKER_TILE.y + 0.5,
    });
    // Nobody else mopped the hold: Bettina is the cook, Mara the captain.
    for (const id of [BETTINA, MARA]) {
      expect(log.labels[id]?.some((l) => l.startsWith("mopping"))).toBe(false);
    }
    const problem = Object.values(test.world.state.work.problems).find(
      (p) => p.kind === "compartmentDirty",
    );
    expect(problem?.status).toBe("resolved");
  });
});

/** Nine hold tiles in a falling gradient: three trips' worth at three tiles a trip. */
const LONG_HOLD_SPOTS: readonly TileCoord[] = [
  ...HOLD_SPOTS,
  { x: 1, y: 5 },
  { x: 0, y: 6 },
  { x: 10, y: 6 },
];

/** A dirt world whose trips take three tiles each, so a dirty hold takes several. */
function shortTripWorld(): TestWorld {
  const base = crewConfig();
  return dirtWorld({ config: { ...base, dirt: { ...base.dirt, mopTilesPerTrip: 3 } } });
}

const tileKey = (tile: TileCoord): string => `${tile.x},${tile.y}`;

describe("back-to-back mopping trips (§mop-trips)", () => {
  it("the next trip takes the dirtiest tiles now, not the ones the last trip mopped clean", () => {
    const test = shortTripWorld();
    soilSpots(test, LONG_HOLD_SPOTS);
    // Each trip is one plan: the tiles its moveTo steps walk to, each followed by a stroke.
    const trips: { plan: object; tiles: TileCoord[] }[] = [];
    run(test, 4000, (world) => {
      for (const actor of Object.values(world.state.actors)) {
        const plan = actor.activity.kind === "task" ? actor.activity.plan : undefined;
        if (plan === undefined || cleaningTaskOf(test, actor.id) === undefined) continue;
        if (trips.some((trip) => trip.plan === plan)) continue;
        const tiles = plan.steps.flatMap((step, i) => {
          const next = plan.steps[i + 1];
          const stroke = next?.kind === "work" && next.ticksNeeded > 0;
          return step.kind === "moveTo" && stroke && !("machineId" in step.target)
            ? [{ x: step.target.x, y: step.target.y }]
            : [];
        });
        trips.push({ plan, tiles });
      }
      // Between the first trip's settling and the next claim the task still lists that trip's
      // tiles until a derivation pass refreshes it, every `DERIVATION_EVERY_TICKS`; whether a
      // claim lands inside that window is down to timing (QA: Tomas at the very next tick). Hold
      // the window open: the unclaimed task keeps the first trip's tiles until someone claims it.
      const [first] = trips;
      const task = Object.values(world.state.work.tasks).find(
        (t) => t.type === "cleanCompartment" && t.status === "pending",
      );
      if (trips.length === 1 && first !== undefined && task !== undefined) {
        task.interactionTiles = first.tiles.map((tile) => ({ ...tile }));
      }
      return trips.length >= 2;
    });
    const [first, second] = trips;
    expect(first?.tiles).toHaveLength(3);
    for (const tile of first?.tiles ?? []) expect(cellAt(test, tile)).toBeLessThan(10);
    expect(second?.tiles).toHaveLength(3);
    const firstKeys = (first?.tiles ?? []).map(tileKey);
    for (const tile of second?.tiles ?? []) expect(firstKeys).not.toContain(tileKey(tile));
  });

  it("between tiles of the room being mopped the label says mopping, not walking to it", () => {
    const test = shortTripWorld();
    soilSpots(test, HOLD_SPOTS);
    const walkLabels = new Set<string>();
    run(test, 3000, (world) => {
      const actor = world.state.actors[JON];
      const plan = actor?.activity.kind === "task" ? actor.activity.plan : undefined;
      const step = plan?.steps[plan.stepIndex];
      const moppedOne = plan?.steps.slice(0, plan.stepIndex).some((s) => s.kind === "work");
      const toMop = plan?.steps[(plan?.stepIndex ?? 0) + 1]?.kind === "work";
      if (actor !== undefined && step?.kind === "moveTo" && moppedOne === true && toMop) {
        walkLabels.add(actionLabel(actor, world.state, world.content));
      }
      return resolvedDirtProblems(world).length > 0;
    });
    expect([...walkLabels]).toEqual(["mopping the corridor"]);
  });
});

/** The `compartmentDirty` problems resolved so far. */
function resolvedDirtProblems(world: TestWorld["world"]) {
  return Object.values(world.state.work.problems).filter(
    (p) => p.kind === "compartmentDirty" && p.status === "resolved",
  );
}

describe("who mops (§who-mops)", () => {
  it("the cook mops the galley, not the deckhand", () => {
    const test = dirtWorld();
    soilSpots(test, GALLEY_SPOTS);
    expect(moppers(test, 400)).toEqual([BETTINA]);
  });

  it("the captain mops nothing until the problem ages", () => {
    const test = dirtWorld();
    // Only Mara is free: the others are off the deck's work for the test.
    for (const id of [JON, BETTINA]) {
      const actor = test.world.state.actors[id];
      if (actor !== undefined) actor.availability = "offShip";
    }
    soilSpots(test, HOLD_SPOTS);
    const config = test.world.config.values;
    const agingTicks =
      config.urgency.cleaningAgingDays * config.time.daySeconds * config.time.tickRate;
    // Before aging (a pass to raise, a derivation, then the aging window): not her room.
    expect(moppers(test, agingTicks - 40)).toEqual([]);
    expect(moppers(test, 400)).toEqual([MARA]);
  });

  it("an on-duty engineer with a dirty engineering room mops before walking rounds", () => {
    const test = dirtWorld({ scenario: DIRT_DECK.engineerOnDuty });
    placeAt(test, PRIYA, { x: 9, y: 2 });
    soilSpots(test, ENGINEERING_SPOTS);
    expect(moppers(test, 400)).toEqual([PRIYA]);
  });

  it("an off-duty engineer does not", () => {
    const test = dirtWorld();
    placeAt(test, PRIYA, { x: 9, y: 2 });
    soilSpots(test, ENGINEERING_SPOTS);
    const config = test.world.config.values;
    const agingTicks =
      config.urgency.cleaningAgingDays * config.time.daySeconds * config.time.tickRate;
    // Nobody may take it before it ages, and Priya (off duty) never: after aging the on-duty
    // crew go instead.
    const who = moppers(test, agingTicks + 400);
    expect(who).not.toContain(PRIYA);
  });
});
