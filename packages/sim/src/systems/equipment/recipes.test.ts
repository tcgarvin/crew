import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { allocateId } from "../../core/ids";
import type { ActorId, MachineId, ProblemId, TaskId } from "../../core/types/ids";
import type { Machine } from "../../core/types/ship";
import type { DerivationCtx, ProblemOfKind, Task, TaskSpec } from "../../core/types/work";
import { w5TestWorld } from "./fixtures/test-world";
import { W5 } from "./fixtures/w5-content";
import { type RecipeCtx, type RecipeOutcome, advanceStage } from "./recipes";
import { equipmentTaskDerivation } from "./tasks";

type W5World = ReturnType<typeof w5TestWorld>["world"];

/** Enough ticks to finish any stage outright. */
const ALL_THE_TICKS = Number.MAX_SAFE_INTEGER;

/** 20s of diagnosis at 20 ticks/s. */
const DIAGNOSE_TICKS = 20 * 20;

function byDef(world: W5World, defId: string): Machine {
  const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`no machine for ${defId}`);
  return machine;
}

function installTask(world: W5World, problemId: ProblemId, spec: TaskSpec): TaskId {
  const id = allocateId(world.state, "task");
  const task: Task = {
    id,
    problemId,
    createdTick: world.state.tick,
    revision: 0,
    status: "active",
    claimState: { kind: "unclaimed" },
    ...spec,
  };
  world.state.work.tasks[id] = task;
  return id;
}

/** Fire `wornBearing` on the engine immediately via `scheduleFault`, going through `applyFault`. */
function injectEngineFault(world: W5World, kernel: ReturnType<typeof w5TestWorld>["kernel"]) {
  const engine = byDef(world, W5.engine);
  kernel.enqueueCommand(
    world,
    cmd({
      source: "scenario",
      kind: "scheduleFault",
      payload: { machineId: engine.id, faultKey: "wornBearing", windowTicks: [0, 0] },
    }),
  );
  kernel.advance(world, 1);
  return engine.id;
}

function ctxOf(world: W5World): DerivationCtx {
  return {
    content: world.content,
    config: world.config.values,
    tick: world.state.tick,
    state: world.state,
  };
}

function recipeCtxOf(world: W5World): RecipeCtx {
  return {
    state: world.state,
    content: world.content,
    config: world.config.values,
    tick: world.state.tick,
  };
}

function machineProblem<K extends "machineSymptom" | "machineFault">(
  world: W5World,
  kind: K,
  machineId: MachineId,
): ProblemOfKind<K> | undefined {
  return Object.values(world.state.work.problems).find(
    (p) => p.kind === kind && (p.payload as { machineId?: MachineId }).machineId === machineId,
  ) as ProblemOfKind<K> | undefined;
}

function bearingsAboard(world: W5World): number {
  return Object.values(world.state.items)
    .filter((i) => i.defId === W5.bearing && i.stacking === "stack")
    .reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 0), 0);
}

/** Diagnose the machine's symptom outright, then install the repair task it leads to. */
function diagnoseThenPlanRepair(
  world: W5World,
  recipeCtx: RecipeCtx,
  machineId: MachineId,
  techId: ActorId,
): { readonly diagnosis: RecipeOutcome; readonly repairTaskId: TaskId } {
  const symptom = machineProblem(world, "machineSymptom", machineId);
  if (symptom === undefined) throw new Error("no symptom problem");
  const inspectSpecs = equipmentTaskDerivation.machineSymptom?.(symptom, ctxOf(world)) ?? [];
  const inspectTaskId = installTask(world, symptom.id, inspectSpecs[0] as TaskSpec);
  const diagnosis = advanceStage(recipeCtx, inspectTaskId, techId, DIAGNOSE_TICKS);
  const fault = machineProblem(world, "machineFault", machineId);
  if (fault === undefined) throw new Error("no fault problem");
  const repairSpecs = equipmentTaskDerivation.machineFault?.(fault, ctxOf(world)) ?? [];
  return { diagnosis, repairTaskId: installTask(world, fault.id, repairSpecs[0] as TaskSpec) };
}

describe("machineSymptom -> inspect -> machineFault -> repair -> repaired", () => {
  it("runs the full recipe, consuming the part exactly once and surviving a worker swap", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);

    const symptom = machineProblem(world, "machineSymptom", machineId);
    expect(symptom).toBeDefined();
    if (symptom === undefined) throw new Error("unreachable");

    const inspectSpecs = equipmentTaskDerivation.machineSymptom?.(symptom, ctxOf(world)) ?? [];
    expect(inspectSpecs).toHaveLength(1);
    const inspectTaskId = installTask(world, symptom.id, inspectSpecs[0] as TaskSpec);

    const recipeCtx = recipeCtxOf(world);
    const diagnosed = advanceStage(recipeCtx, inspectTaskId, techId, DIAGNOSE_TICKS);
    expect(diagnosed.status).toBe("recipeComplete");
    expect(diagnosed.status === "recipeComplete" && diagnosed.events.map((e) => e.type)).toContain(
      "faultDiagnosed",
    );
    expect(world.state.work.problems[symptom.id]?.status).toBe("resolved");

    const fault = machineProblem(world, "machineFault", machineId);
    expect(fault).toBeDefined();
    if (fault === undefined) throw new Error("unreachable");

    const repairSpecs = equipmentTaskDerivation.machineFault?.(fault, ctxOf(world)) ?? [];
    expect(repairSpecs).toHaveLength(1);
    expect(repairSpecs[0]?.requiredTools).toEqual(["wrench"]);
    const repairTaskId = installTask(world, fault.id, repairSpecs[0] as TaskSpec);

    expect(bearingsAboard(world)).toBe(2);

    // First worker does half the repair...
    const repairTicks = 10 * 20;
    const otherWorker = "aFakeOther" as ActorId;
    const partial = advanceStage(recipeCtx, repairTaskId, otherWorker, Math.floor(repairTicks / 2));
    expect(partial).toMatchObject({ status: "inProgress" });
    expect(partial.status === "inProgress" && partial.progress).toBeCloseTo(0.5, 1);
    // ...no part consumed yet at the halfway point.
    expect(bearingsAboard(world)).toBe(2);

    // ...then a different worker (the tech, who actually carries the part) finishes it.
    const finished = advanceStage(recipeCtx, repairTaskId, techId, ALL_THE_TICKS);
    expect(finished.status).toBe("recipeComplete");
    expect(finished.status === "recipeComplete" && finished.events.map((e) => e.type)).toContain(
      "faultRepaired",
    );

    const engine = byDef(world, W5.engine);
    expect(engine.faults).toEqual([]);
    expect(engine.condition).toBeGreaterThan(0.9); // restored, was already ~1
    expect(world.state.work.problems[fault.id]?.status).toBe("resolved");

    expect(bearingsAboard(world)).toBe(1); // consumed exactly once
  });

  it("survives a save/restore mid-repair", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);
    const symptom = machineProblem(
      world,
      "machineSymptom",
      machineId,
    ) as ProblemOfKind<"machineSymptom">;
    const inspectSpecs = equipmentTaskDerivation.machineSymptom?.(symptom, ctxOf(world)) ?? [];
    const inspectTaskId = installTask(world, symptom.id, inspectSpecs[0] as TaskSpec);

    advanceStage(recipeCtxOf(world), inspectTaskId, techId, 10 * 20); // half of the 20s diagnosis

    const envelope = kernel.serialize(world);
    const restored = kernel.restore(envelope, world.content);
    const restoredEngine = byDef(restored, W5.engine);
    expect(restoredEngine.faults[0]?.repairStepProgress).toBeCloseTo(0.5, 1);

    const done = advanceStage(recipeCtxOf(restored), inspectTaskId, techId, 10 * 20);
    expect(done.status).toBe("recipeComplete");
  });
});

describe("integrity restore on repair (D35)", () => {
  it("lifts a blocked machine's integrity back to the derate threshold when the repair completes", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);
    const recipeCtx = recipeCtxOf(world);
    const { diagnosis, repairTaskId } = diagnoseThenPlanRepair(world, recipeCtx, machineId, techId);
    expect(diagnosis.status).toBe("recipeComplete");

    const engine = byDef(world, W5.engine);
    engine.integrity = 0.05; // below `integrityInoperableBelow`: blocked
    const finished = advanceStage(recipeCtx, repairTaskId, techId, ALL_THE_TICKS);
    expect(finished.status).toBe("recipeComplete");
    expect(engine.faults).toEqual([]);
    expect(engine.integrity).toBe(world.config.values.equipment.integrityDerateBelow);

    // Machine runs again at full output once integrity is back at the threshold.
    kernel.advance(world, 1);
    expect(engine.actualMode).toBe("on");
    expect(engine.output).toBe(1);
  });

  it("never lowers integrity on repair", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);
    const recipeCtx = recipeCtxOf(world);
    const { repairTaskId } = diagnoseThenPlanRepair(world, recipeCtx, machineId, techId);
    const engine = byDef(world, W5.engine);
    engine.integrity = 0.9;
    advanceStage(recipeCtx, repairTaskId, techId, ALL_THE_TICKS);
    expect(engine.integrity).toBe(0.9);
  });
});

describe("a repair carries its fault's cause (D100)", () => {
  function repairedEvent(outcome: RecipeOutcome) {
    if (outcome.status !== "recipeComplete") throw new Error(`repair is ${outcome.status}`);
    const event = outcome.events.find((e) => e.type === "faultRepaired");
    if (event === undefined) throw new Error("no faultRepaired event");
    return event;
  }

  it("names the command that caused the fault, so the narrator's aftermath call can follow it", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);
    const cause = byDef(world, W5.engine).faults[0]?.causeCommandId;
    expect(cause).toBeDefined();
    const recipeCtx = recipeCtxOf(world);
    const { repairTaskId } = diagnoseThenPlanRepair(world, recipeCtx, machineId, techId);
    const finished = advanceStage(recipeCtx, repairTaskId, techId, ALL_THE_TICKS);
    expect(repairedEvent(finished).causeIds).toEqual([cause]);
  });

  it("names no cause for a fault that came from wear", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);
    const fault = byDef(world, W5.engine).faults[0];
    if (fault === undefined) throw new Error("no fault");
    // biome-ignore lint/performance/noDelete: a wear fault has no cause key at all.
    delete fault.causeCommandId;
    const recipeCtx = recipeCtxOf(world);
    const { repairTaskId } = diagnoseThenPlanRepair(world, recipeCtx, machineId, techId);
    const finished = advanceStage(recipeCtx, repairTaskId, techId, ALL_THE_TICKS);
    expect(repairedEvent(finished).causeIds).toEqual([]);
  });
});
