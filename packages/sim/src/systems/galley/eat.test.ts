/**
 * Eating (§eating): `consumeServing`'s hunger, thoughts and event; the eat plan's mess seat; the
 * mess call's hold on the gangway stander; the plate carried to the helm.
 */
import { describe, expect, it } from "vitest";
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type { DirtTier, MealQuality } from "../../core/types/content";
import type { ActorId, ItemId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { Task } from "../../core/types/work";
import { carryMealPlan, consumeServing, eatPlan, mealCallStandsFor } from "./eat";
import {
  BETTINA,
  COUNTER,
  GALLEY,
  HELM_SEAT,
  JAX,
  MARA,
  MESS_FLOOR,
  NOOR,
  SEATS,
  STANDBY,
  addServing,
  galleyStepCtx,
  galleyWorld,
  onGalleyDeck as onDeck,
  placeOnGalleyDeck,
} from "./fixtures/galley-deck";

function actor(world: World, id: ActorId) {
  const found = world.state.actors[id];
  if (found === undefined) throw new Error(`no actor ${id}`);
  return found;
}

describe("consumeServing (§eating, call 4)", () => {
  const cases: [string, MealQuality | undefined, DirtTier, string[]][] = [
    ["a good meal: ate well", "good", "clean", ["ateWell"]],
    ["a plain meal: nothing", "plain", "clean", []],
    ["a poor meal: burnt dinner", "poor", "clean", ["burntDinner"]],
    ["a ration: ate a ration pack", undefined, "clean", ["ateRationPack"]],
    ["a good meal in a dirty mess", "good", "dirty", ["ateWell", "ateInDirtyMess"]],
    ["a ration in a filthy mess", undefined, "filthy", ["ateRationPack", "ateInFilthyMess"]],
  ];
  it.each(cases)("%s", (_name, quality, tier, thoughts) => {
    const { world } = galleyWorld();
    placeOnGalleyDeck(world, MARA, SEATS[0] as TileCoord);
    world.state.dirt.tiers.mess = tier;
    const mara = actor(world, MARA);
    mara.needs.hunger = 0.6;
    const item = addServing(world, { kind: "carriedBy", actorId: MARA }, quality, 2);
    const { ctx, drafts } = galleyStepCtx(world);
    consumeServing(ctx, mara, item);
    expect(mara.thoughts.map((t) => t.key)).toEqual(thoughts);
    const nutrition = quality === undefined ? 0.25 : 0.4;
    expect(mara.needs.hunger).toBeCloseTo(0.6 - nutrition);
    expect(item.count).toBe(1);
    const ate = drafts.filter((d) => d.type === "ateMeal");
    expect(ate.map((d) => d.payload)).toEqual([
      { nutrition, ...(quality === undefined ? {} : { quality }), ration: quality === undefined },
    ]);
  });

  it("eats the last unit of a stack away", () => {
    const { world } = galleyWorld();
    const item = addServing(world, { kind: "carriedBy", actorId: MARA }, "good", 1);
    const { ctx } = galleyStepCtx(world);
    consumeServing(ctx, actor(world, MARA), item);
    expect(world.state.items[item.id]).toBeUndefined();
  });
});

describe("the eat plan's seat (§eating, call 6)", () => {
  const moveTargets = (world: World, id: ActorId, itemId: ItemId) => {
    const { ctx } = galleyStepCtx(world);
    const plan = eatPlan(ctx, actor(world, id), itemId, MESS_FLOOR);
    if (!plan.ok) throw new Error(`blocked: ${plan.reason}`);
    return plan.plan.steps.flatMap((s) => (s.kind === "moveTo" ? [s.target] : []));
  };

  it("fetches the serving, then sits at the free seat nearest it", () => {
    const { world } = galleyWorld();
    placeOnGalleyDeck(world, MARA, { x: 10, y: 0 });
    const stack = addServing(world, onDeck(COUNTER), "good", 3);
    const targets = moveTargets(world, MARA, stack.id);
    expect(targets[0]).toEqual(COUNTER);
    // Seats (7,0) and (7,2) are nearest the counter at (4,1); (7,0) comes first in the def.
    expect(targets[1]).toMatchObject({ positionKey: "seat_1" });
  });

  it("passes over a seat someone holds or is on their way to", () => {
    const { world } = galleyWorld();
    const stack = addServing(world, onDeck(COUNTER), "good", 3);
    // Noor has seat 1 planned (her walk to it not begun); Jax sits on seat 2, which he holds.
    const { ctx } = galleyStepCtx(world);
    const noorPlan = eatPlan(ctx, actor(world, NOOR), stack.id, MESS_FLOOR);
    if (!noorPlan.ok) throw new Error("Noor's plan blocked");
    actor(world, NOOR).activity = {
      kind: "personal",
      activity: "eat",
      urgency: "routineObligation",
      action: { kind: "eat", stage: "fetching", progress: 0, startedTick: 0, interruptible: true },
      sinceTick: 0,
      plan: noorPlan.plan,
    };
    placeOnGalleyDeck(world, JAX, SEATS[1] as TileCoord);
    world.caches.nav.reservations[`${GALLEY.deck}:8,0`] = [JAX];
    const noorSeat = noorPlan.plan.steps.flatMap((s) =>
      s.kind === "moveTo" && "machineId" in s.target ? [s.target.positionKey] : [],
    );
    const maraSeat = moveTargets(world, MARA, stack.id).flatMap((t) =>
      "machineId" in t ? [t.positionKey] : [],
    );
    expect(noorSeat).toEqual(["seat_1"]);
    expect(maraSeat).toHaveLength(1);
    expect(["seat_3", "seat_4"]).toContain(maraSeat[0]);
  });

  it("eats a served meal in hand before a ration in hand", () => {
    const { world } = galleyWorld();
    const ration = addServing(world, { kind: "carriedBy", actorId: MARA }, undefined, 1);
    const meal = addServing(world, { kind: "carriedBy", actorId: MARA }, "plain", 1);
    const { ctx } = galleyStepCtx(world);
    const plan = eatPlan(ctx, actor(world, MARA), undefined, undefined);
    if (!plan.ok) throw new Error("blocked");
    const consume = plan.plan.steps.find((s) => s.kind === "consume");
    expect(consume).toEqual({ kind: "consume", itemId: meal.id });
    expect(consume).not.toEqual({ kind: "consume", itemId: ration.id });
  });

  it("fetches the served meal it was sent for rather than eating the ration in hand", () => {
    const { world } = galleyWorld();
    addServing(world, { kind: "carriedBy", actorId: MARA }, undefined, 1);
    const stack = addServing(world, onDeck(COUNTER), "good", 3);
    const { ctx } = galleyStepCtx(world);
    const plan = eatPlan(ctx, actor(world, MARA), stack.id, undefined);
    if (!plan.ok) throw new Error("blocked");
    expect(plan.plan.steps).toContainEqual({ kind: "pickUp", itemId: stack.id, split: true });
  });
});

describe("the mess call on the gangway (§eating, call 1)", () => {
  it("stands for a hungry stander who knows of a served meal, not for the helm's plate", () => {
    const { world } = galleyWorld();
    const noor = actor(world, NOOR);
    const { ctx } = galleyStepCtx(world);
    noor.needs.hunger = 0.3;
    expect(mealCallStandsFor(ctx, noor)).toBe(false);
    addServing(world, onDeck(STANDBY), "good", 1);
    expect(mealCallStandsFor(ctx, noor)).toBe(false);
    addServing(world, onDeck(COUNTER), "good", 3);
    expect(mealCallStandsFor(ctx, noor)).toBe(true);
    noor.needs.hunger = 0.1;
    expect(mealCallStandsFor(ctx, noor)).toBe(false);
  });
});

describe("the plate for the helm (§eating, call 5)", () => {
  const carryTask = (world: World): Task => ({
    id: "t99" as Task["id"],
    problemId: "p99" as Task["problemId"],
    derivationKey: "carry",
    type: "carryMeal",
    target: { kind: "machine", machineId: "m5" as never },
    createdTick: world.state.tick,
    revision: 1,
    status: "claimed",
    baseUrgency: "routineObligation",
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: [STANDBY],
    dependencyIds: [],
    progressRef: { kind: "occupancy", machineId: "m5" as never },
    claimState: { kind: "unclaimed" },
    completion: { kind: "stepsDone" },
    estimatedWorkSeconds: 0,
  });

  it("splits one serving off the counter, takes it to the standby tile and sets it down", () => {
    const { world } = galleyWorld();
    addServing(world, onDeck(HELM_SEAT), "good", 1);
    const stack = addServing(world, onDeck(COUNTER), "good", 4);
    const { ctx } = galleyStepCtx(world);
    const plan = carryMealPlan(ctx, actor(world, BETTINA), carryTask(world));
    expect(plan).toEqual({
      ok: true,
      plan: {
        stepIndex: 0,
        steps: [
          { kind: "moveTo", target: COUNTER, requested: false },
          { kind: "pickUp", itemId: stack.id, split: true },
          { kind: "moveTo", target: STANDBY, requested: false },
          { kind: "putDown", itemId: stack.id },
        ],
      },
    });
  });

  it("is blocked with no served meal known", () => {
    const { world } = galleyWorld();
    const { ctx } = galleyStepCtx(world);
    expect(carryMealPlan(ctx, actor(world, BETTINA), carryTask(world))).toEqual({
      ok: false,
      reason: "inaccessibleSupply",
    });
  });
});
