/**
 * The planner's galley rules (D81) over views of the galley fixture: the mess call, the eat
 * candidate's choice of food, and who may take the galley's tasks.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { ActorId, MachineId, ProblemId, TaskId } from "../../core/types/ids";
import type { PlannerConfig } from "../../core/types/pipeline";
import type { AgentView, ProblemView, TaskView } from "../../core/types/view";
import type { TaskType } from "../../core/types/work";
import {
  eatCandidate,
  galleyTaskAllowed,
  galleyTaskExempt,
  mealCallFor,
} from "../../planner/galley";
import {
  BETTINA,
  COUNTER,
  JAX,
  MARA,
  NOOR,
  STANDBY,
  TOMAS,
  addServing,
  galleyWorld,
  onGalleyDeck,
  runToSecond,
} from "./fixtures/galley-deck";

/** The fixture after its first look, so everyone knows where things are. */
function looked(): TestWorld {
  const fixture = galleyWorld();
  runToSecond(fixture, 1);
  return fixture;
}

const viewOf = (fixture: TestWorld, id: ActorId): AgentView =>
  fixture.registry.buildAgentView(fixture.world, id);

/** The world's config: a `PlannerConfig` that carries the galley block (as the pipeline will). */
const configOf = (fixture: TestWorld): PlannerConfig => fixture.world.config.values;

function setHunger(fixture: TestWorld, hunger: number): void {
  for (const actor of Object.values(fixture.world.state.actors)) actor.needs.hunger = hunger;
}

describe("the mess call (D81 call 1)", () => {
  it("calls the dayworker and the section off watch, not the section on watch", () => {
    const fixture = looked();
    setHunger(fixture, 0.3);
    const meal = addServing(fixture.world, onGalleyDeck(COUNTER), "good", 6);
    const config = configOf(fixture);
    // Watch 0: Red (Noor, Mara) has it; White (Jax, Tomas) stands the next; Bettina is a dayworker.
    expect(mealCallFor(viewOf(fixture, JAX), config)).toEqual({ itemId: meal.id });
    expect(mealCallFor(viewOf(fixture, TOMAS), config)).toEqual({ itemId: meal.id });
    expect(mealCallFor(viewOf(fixture, BETTINA), config)).toEqual({ itemId: meal.id });
    expect(mealCallFor(viewOf(fixture, MARA), config)).toBeUndefined();
  });

  it("calls the section on watch's gangway stander, who comes and goes back", () => {
    const fixture = looked();
    setHunger(fixture, 0.3);
    addServing(fixture.world, onGalleyDeck(COUNTER), "good", 6);
    const noor = viewOf(fixture, NOOR);
    expect(noor.self.watch).toMatchObject({ onWatch: true, gangway: true });
    expect(mealCallFor(noor, configOf(fixture))).toBeDefined();
  });

  it("does not call below the hunger threshold, nor to the helm-stander's plate", () => {
    const fixture = looked();
    addServing(fixture.world, onGalleyDeck(STANDBY), "good", 1);
    setHunger(fixture, 0.3);
    expect(mealCallFor(viewOf(fixture, JAX), configOf(fixture))).toBeUndefined();
    addServing(fixture.world, onGalleyDeck(COUNTER), "good", 6);
    setHunger(fixture, 0.15);
    expect(mealCallFor(viewOf(fixture, JAX), configOf(fixture))).toBeUndefined();
  });

  // Transitional: until the pipeline passes the galley block to the planner, there is no call.
  it("is silent while the planner's config carries no galley block", () => {
    const fixture = looked();
    setHunger(fixture, 0.3);
    addServing(fixture.world, onGalleyDeck(COUNTER), "good", 6);
    const { work, urgency, needs, time } = fixture.world.config.values;
    const bare = { work, urgency, needs, time } as PlannerConfig;
    expect(mealCallFor(viewOf(fixture, JAX), bare)).toBeUndefined();
  });
});

describe("the eat candidate (D81)", () => {
  it("answers the call at routine class below the seek threshold", () => {
    const fixture = looked();
    setHunger(fixture, 0.3);
    const meal = addServing(fixture.world, onGalleyDeck(COUNTER), "good", 6);
    const candidate = eatCandidate(viewOf(fixture, JAX), configOf(fixture));
    expect(candidate).toMatchObject({
      urgency: "routineObligation",
      choice: { kind: "personal", activity: "eat", itemId: meal.id },
    });
  });

  it("past the seek threshold prefers a served meal to a nearer ration", () => {
    const fixture = looked();
    setHunger(fixture, 0.6);
    const meal = addServing(fixture.world, onGalleyDeck(COUNTER), "plain", 6);
    // Mara is on watch (no call), but hungry: need-driven, and the meal still wins.
    const candidate = eatCandidate(viewOf(fixture, MARA), configOf(fixture));
    expect(candidate).toMatchObject({ choice: { itemId: meal.id } });
  });

  it("with only a ration in hand, the call sends them to the counter rather than eating it", () => {
    const fixture = looked();
    setHunger(fixture, 0.3);
    addServing(fixture.world, { kind: "carriedBy", actorId: JAX }, undefined, 1);
    const meal = addServing(fixture.world, onGalleyDeck(COUNTER), "good", 6);
    expect(eatCandidate(viewOf(fixture, JAX), configOf(fixture))).toMatchObject({
      choice: { itemId: meal.id },
    });
  });
});

describe("who takes the galley's tasks (D81 calls 3 and 5)", () => {
  const task = (type: TaskType): TaskView => ({
    id: "t1" as TaskId,
    problemId: "p1" as ProblemId,
    derivationKey: type === "cookMeal" ? "cook" : "carry",
    type,
    target: { kind: "machine", machineId: "m1" as MachineId },
    createdTick: 0,
    revision: 1,
    status: "pending",
    baseUrgency: "routineObligation",
    requiredSkills: type === "cookMeal" ? [{ skill: "cooking", min: 1 }] : [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: [],
    dependencyIds: [],
    progressRef: { kind: "meal", watchIndex: 1 },
    completion: { kind: "problemResolved" },
    estimatedWorkSeconds: 10,
  });
  const cookProblem = (createdTick: number): ProblemView => ({
    id: "p1" as ProblemId,
    kind: "mealToCook",
    payload: { watchIndex: 1 },
    owner: "galley",
    visibility: "public",
    dedupeKey: "meal:1",
    status: "open",
    createdTick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "machine", machineId: "m1" as MachineId },
  });
  const carryProblem = (createdTick: number): ProblemView => ({
    ...cookProblem(createdTick),
    kind: "mealToCarry",
    payload: { toActorId: NOOR, machineId: "m1" as MachineId },
    dedupeKey: "mealToCarry:m1",
  });

  it("cookMeal: the cook at once, anyone else once substituteAfterDays have passed", () => {
    const fixture = looked();
    const config = configOf(fixture);
    const now = fixture.world.state.tick;
    const wait = Math.ceil(
      config.time.daySeconds *
        config.time.tickRate *
        fixture.world.config.values.galley.substituteAfterDays,
    );
    const fresh = cookProblem(now);
    const aged = cookProblem(now - wait);
    expect(galleyTaskAllowed(viewOf(fixture, BETTINA), config, task("cookMeal"), fresh)).toBe(true);
    expect(galleyTaskAllowed(viewOf(fixture, TOMAS), config, task("cookMeal"), fresh)).toBe(false);
    expect(galleyTaskAllowed(viewOf(fixture, TOMAS), config, task("cookMeal"), aged)).toBe(true);
    expect(galleyTaskExempt(viewOf(fixture, BETTINA), task("cookMeal"))).toBe(true);
    expect(galleyTaskExempt(viewOf(fixture, TOMAS), task("cookMeal"))).toBe(false);
    expect(galleyTaskExempt(viewOf(fixture, BETTINA), task("carryMeal"))).toBe(false);
  });

  it("carryMeal: the cook or a dayworker, anyone after routineAgingDays, never the stander", () => {
    const fixture = looked();
    const config = configOf(fixture);
    const now = fixture.world.state.tick;
    const aging = Math.ceil(
      config.time.daySeconds * config.time.tickRate * config.urgency.routineAgingDays,
    );
    const fresh = carryProblem(now);
    const aged = carryProblem(now - aging);
    expect(galleyTaskAllowed(viewOf(fixture, BETTINA), config, task("carryMeal"), fresh)).toBe(
      true,
    );
    expect(galleyTaskAllowed(viewOf(fixture, JAX), config, task("carryMeal"), fresh)).toBe(false);
    expect(galleyTaskAllowed(viewOf(fixture, JAX), config, task("carryMeal"), aged)).toBe(true);
    expect(galleyTaskAllowed(viewOf(fixture, NOOR), config, task("carryMeal"), aged)).toBe(false);
  });
});
