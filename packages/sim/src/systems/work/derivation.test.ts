import { describe, expect, it } from "vitest";
import type { DeriveTasks } from "../../core/types/work";
import { PROBLEM_KINDS, createTaskDerivationRegistry } from "./derivation";
import { ALL_DERIVATIONS, JON, MARA, addCrateToLoad, crewWorld, place } from "./fixtures/crew-deck";
import { run } from "./fixtures/run";

describe("task derivation", () => {
  it("dedupes by (problem, derivationKey) and refreshes in place on a problem revision", () => {
    const tw = crewWorld();
    const { world } = tw;
    for (const id of [MARA, JON]) {
      const actor = world.state.actors[id];
      if (actor !== undefined) actor.availability = "incapacitated";
    }
    const { problemId } = addCrateToLoad(world, { x: 3, y: 6 });
    run(tw, 30);
    const forProblem = () =>
      Object.values(world.state.work.tasks).filter((t) => t.problemId === problemId);
    expect(forProblem()).toHaveLength(1);
    const task = forProblem()[0];
    expect(task?.status).toBe("pending");
    expect(task?.revision).toBe(1);

    const problem = world.state.work.problems[problemId];
    if (problem === undefined) throw new Error("no problem");
    problem.revision = 2;
    run(tw, 20);
    expect(forProblem()).toHaveLength(1);
    expect(forProblem()[0]?.id).toBe(task?.id);
    expect(forProblem()[0]?.revision).toBe(2);

    problem.status = "cancelled";
    run(tw, 10);
    // Cancelled and no longer referenced: pruned.
    expect(forProblem()).toHaveLength(0);
  });

  it("completes the tasks of a resolved problem and releases their claims", () => {
    const tw = crewWorld();
    const { world } = tw;
    place(world, MARA, { x: 2, y: 6 });
    place(world, JON, { x: 11, y: 5 });
    const { problemId } = addCrateToLoad(world, { x: 3, y: 6 });
    run(tw, 25, () => Object.keys(world.state.work.claims).length > 0);
    expect(Object.keys(world.state.work.claims)).toHaveLength(1);
    const problem = world.state.work.problems[problemId];
    if (problem === undefined) throw new Error("no problem");
    problem.status = "resolved";
    run(tw, 12);
    expect(Object.keys(world.state.work.claims)).toHaveLength(0);
    expect(world.state.actors[MARA]?.activity.kind).not.toBe("task");
  });

  it("registers rules per kind, refuses duplicates and reports missing kinds", () => {
    const rules = createTaskDerivationRegistry();
    expect(rules.missingKinds()).toEqual(PROBLEM_KINDS);
    const rule = ALL_DERIVATIONS.cargoToLoad as DeriveTasks<"cargoToLoad">;
    const off = rules.register("cargoToLoad", rule);
    expect(() => rules.register("cargoToLoad", rule)).toThrow(/already registered/);
    expect(rules.missingKinds()).not.toContain("cargoToLoad");
    off();
    expect(rules.rule("cargoToLoad")).toBeUndefined();
    expect(createTaskDerivationRegistry(ALL_DERIVATIONS).missingKinds()).toEqual([]);
  });
});
