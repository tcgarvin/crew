/**
 * Cooking (§cooking-and-serving): the meal's quality, the cook's plan, the serve's count, and the
 * galley's task derivations.
 */
import { describe, expect, it } from "vitest";
import type { DirtTier } from "../../core/types/content";
import type { ProblemId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { ProblemOfKind, Task } from "../../core/types/work";
import { cookPlan } from "./cook";
import {
  BETTINA,
  COUNTER,
  GALLEY,
  GALLEY_WATCH,
  NOOR,
  STANDBY,
  STOVE_USE,
  galleyConfig,
  galleyStepCtx,
  galleyWorld,
  ofType,
  runToSecond,
} from "./fixtures/galley-deck";
import { mealQuality, positionTiles, stoveOf } from "./kitchen";
import { deriveMealToCarry, deriveMealToCook } from "./tasks";

describe("meal quality (§cooking-and-serving, call 4)", () => {
  const config = galleyConfig();
  const cases: [number, DirtTier, string][] = [
    [8, "clean", "good"],
    [6, "untidy", "good"],
    [5, "clean", "plain"],
    [3, "clean", "plain"],
    [2, "clean", "poor"],
    [8, "dirty", "plain"],
    [8, "filthy", "plain"],
    [4, "dirty", "poor"],
    [1, "filthy", "poor"],
  ];
  it.each(cases)("cooking %i in a %s galley serves %s", (cooking, tier, quality) => {
    expect(mealQuality(cooking, tier, config)).toBe(quality);
  });
});

function mealProblem(world: World): ProblemOfKind<"mealToCook"> {
  const stove = stoveOf(world.state, world.content);
  if (stove === undefined) throw new Error("no stove");
  return {
    id: "p90" as ProblemId,
    kind: "mealToCook",
    payload: { watchIndex: 1 },
    owner: "galley",
    visibility: "public",
    dedupeKey: "meal:1",
    status: "open",
    createdTick: world.state.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "machine", machineId: stove.id },
  };
}

function derivationCtx(world: World) {
  return {
    content: world.content,
    config: world.config.values,
    tick: world.state.tick,
    state: world.state,
  };
}

function cookTask(world: World): Task {
  const [spec] = deriveMealToCook(mealProblem(world), derivationCtx(world));
  if (spec === undefined) throw new Error("no cookMeal task derived");
  return {
    ...spec,
    id: "t90" as Task["id"],
    problemId: "p90" as ProblemId,
    createdTick: world.state.tick,
    revision: 1,
    status: "claimed",
    claimState: { kind: "unclaimed" },
  };
}

describe("the galley's task derivations (§cooking-and-serving)", () => {
  it("mealToCook derives one cookMeal at the stove: cooking 1, the crate set down if given up", () => {
    const { world } = galleyWorld();
    const stove = stoveOf(world.state, world.content);
    expect(deriveMealToCook(mealProblem(world), derivationCtx(world))).toEqual([
      {
        derivationKey: "cook",
        type: "cookMeal",
        target: { kind: "machine", machineId: stove?.id },
        baseUrgency: "routineObligation",
        requiredSkills: [{ skill: "cooking", min: 1 }],
        requiredTools: [],
        consumables: [{ itemDefId: GALLEY.provisions, count: 1 }],
        workerSlots: 1,
        interactionTiles: [STOVE_USE],
        dependencyIds: [],
        progressRef: { kind: "meal", watchIndex: 1 },
        completion: { kind: "problemResolved" },
        estimatedWorkSeconds: 10,
      },
    ]);
  });

  it("mealToCarry derives one carryMeal to the helm's standby tile, done when set down", () => {
    const { world } = galleyWorld();
    const helm = Object.values(world.state.machines).find((m) => m.defId === GALLEY.helm);
    if (helm === undefined) throw new Error("no helm");
    expect(positionTiles(world.state, world.content, helm.id, "use")).toEqual([STANDBY]);
    const [spec] = deriveMealToCarry(
      {
        id: "p91" as ProblemId,
        kind: "mealToCarry",
        payload: { toActorId: NOOR, machineId: helm.id },
        owner: "galley",
        visibility: "public",
        dedupeKey: `mealToCarry:${helm.id}`,
        status: "open",
        createdTick: 0,
        revision: 1,
        baseUrgency: "routineObligation",
        location: { kind: "machine", machineId: helm.id },
      },
      derivationCtx(world),
    );
    expect(spec).toMatchObject({
      type: "carryMeal",
      requiredSkills: [],
      interactionTiles: [STANDBY],
      completion: { kind: "stepsDone" },
      estimatedWorkSeconds: 0,
    });
  });
});

describe("the cook's plan (§cooking-and-serving, call 2)", () => {
  it("splits one crate off the nearest pantry stack, cooks at the stove, serves on the counter", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    // The first look: everyone learns where things are.
    runToSecond(fixture, 1);
    const { ctx } = galleyStepCtx(world);
    const crate = Object.values(world.state.items).find((i) => i.defId === GALLEY.provisions);
    if (crate === undefined || crate.location.kind !== "onDeck") throw new Error("no crate");
    const plan = cookPlan(ctx, world.state.actors[BETTINA] as never, cookTask(world));
    if (!plan.ok) throw new Error(`blocked: ${plan.reason}`);
    expect(plan.plan.steps).toEqual([
      {
        kind: "moveTo",
        target: { x: Math.floor(crate.location.x), y: Math.floor(crate.location.y) },
        requested: false,
      },
      { kind: "pickUp", itemId: crate.id, split: true },
      {
        kind: "moveTo",
        target: { machineId: expect.any(String), positionKey: "front" },
        requested: false,
      },
      { kind: "work", stage: "cook", ticksDone: 0, ticksNeeded: 200 },
      { kind: "moveTo", target: COUNTER, requested: false },
      { kind: "serve" },
    ]);
  });

  it("is blocked when the cook knows of no provisions", () => {
    const fixture = galleyWorld({ crates: 0 });
    const { world } = fixture;
    runToSecond(fixture, 1);
    const { ctx } = galleyStepCtx(world);
    const plan = cookPlan(ctx, world.state.actors[BETTINA] as never, cookTask(world));
    expect(plan).toEqual({ ok: false, reason: "inaccessibleSupply" });
  });
});

describe("the serve (§cooking-and-serving, call 2)", () => {
  it("serves the crew aboard plus the spare, never more than a crate makes", () => {
    const fixture = galleyWorld({ config: galleyConfig({ servingsPerCrate: 4 }) });
    const events = runToSecond(fixture, GALLEY_WATCH);
    expect(ofType(events, "mealServed").map((e) => e.payload.servings)).toEqual([4]);
    const crates = Object.values(fixture.world.state.items)
      .filter((i) => i.defId === GALLEY.provisions)
      .reduce((n, i) => n + (i.stacking === "stack" ? i.count : 1), 0);
    expect(crates).toBe(5);
  });

  it.each([
    [8, "good", true],
    [4, "plain", false],
  ] as const)(
    "a cook at cooking %i serves %s and is pleased with it: %s",
    (cooking, quality, pleased) => {
      const fixture = galleyWorld();
      const bettina = fixture.world.state.actors[BETTINA];
      if (bettina === undefined) throw new Error("no Bettina");
      bettina.skills = { ...bettina.skills, cooking };
      const events = runToSecond(fixture, GALLEY_WATCH);
      expect(ofType(events, "mealServed").map((e) => e.payload.quality)).toEqual([quality]);
      expect(bettina.thoughts.some((t) => t.key === "cookedWell")).toBe(pleased);
    },
  );
});
