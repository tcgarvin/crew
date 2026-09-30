import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { allocateId } from "../../core/ids";
import type { ActorId, ProblemId, TaskId } from "../../core/types/ids";
import type { Machine } from "../../core/types/ship";
import type { DerivationCtx, ProblemOfKind, Task, TaskSpec } from "../../core/types/work";
import { w5TestWorld } from "./fixtures/test-world";
import { W5 } from "./fixtures/w5-content";
import { advanceStage, beginStage, completeStage } from "./recipes";
import { equipmentTaskDerivation } from "./tasks";

function byDef(world: ReturnType<typeof w5TestWorld>["world"], defId: string): Machine {
  const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`no machine for ${defId}`);
  return machine;
}

function installTask(
  world: ReturnType<typeof w5TestWorld>["world"],
  problemId: ProblemId,
  spec: TaskSpec,
): TaskId {
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
function injectEngineFault(
  world: ReturnType<typeof w5TestWorld>["world"],
  kernel: ReturnType<typeof w5TestWorld>["kernel"],
) {
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

function ctxOf(world: ReturnType<typeof w5TestWorld>["world"]): DerivationCtx {
  return {
    content: world.content,
    config: world.config.values,
    tick: world.state.tick,
    state: world.state,
  };
}

describe("machineSymptom -> inspect -> machineFault -> repair -> repaired", () => {
  it("runs the full recipe, consuming the part exactly once and surviving a worker swap", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);

    const symptom = Object.values(world.state.work.problems).find(
      (p): p is ProblemOfKind<"machineSymptom"> =>
        p.kind === "machineSymptom" && p.payload.machineId === machineId,
    );
    expect(symptom).toBeDefined();
    if (symptom === undefined) throw new Error("unreachable");

    const inspectSpecs = equipmentTaskDerivation.machineSymptom?.(symptom, ctxOf(world)) ?? [];
    expect(inspectSpecs).toHaveLength(1);
    const inspectTaskId = installTask(world, symptom.id, inspectSpecs[0] as TaskSpec);

    const recipeCtx = {
      state: world.state,
      content: world.content,
      config: world.config.values,
      tick: world.state.tick,
    };
    expect(beginStage(recipeCtx, inspectTaskId, techId)).toMatchObject({
      status: "inProgress",
      progress: 0,
    });

    // 20s of diagnosis at 20 ticks/s.
    const diagnoseTicks = 20 * 20;
    const diagnosed = advanceStage(recipeCtx, inspectTaskId, techId, diagnoseTicks);
    expect(diagnosed.status).toBe("recipeComplete");
    expect(diagnosed.status === "recipeComplete" && diagnosed.events.map((e) => e.type)).toContain(
      "faultDiagnosed",
    );
    expect(world.state.work.problems[symptom.id]?.status).toBe("resolved");

    const fault = Object.values(world.state.work.problems).find(
      (p): p is ProblemOfKind<"machineFault"> =>
        p.kind === "machineFault" && p.payload.machineId === machineId,
    );
    expect(fault).toBeDefined();
    if (fault === undefined) throw new Error("unreachable");

    const repairSpecs = equipmentTaskDerivation.machineFault?.(fault, ctxOf(world)) ?? [];
    expect(repairSpecs).toHaveLength(1);
    expect(repairSpecs[0]?.requiredTools).toEqual(["wrench"]);
    const repairTaskId = installTask(world, fault.id, repairSpecs[0] as TaskSpec);

    const bearingCountBefore = Object.values(world.state.items)
      .filter((i) => i.defId === W5.bearing && i.stacking === "stack")
      .reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 0), 0);
    expect(bearingCountBefore).toBe(2);

    // First worker does half the repair...
    const repairTicks = 10 * 20;
    const otherWorker = "aFakeOther" as ActorId;
    const partial = advanceStage(recipeCtx, repairTaskId, otherWorker, Math.floor(repairTicks / 2));
    expect(partial).toMatchObject({ status: "inProgress" });
    expect(partial.status === "inProgress" && partial.progress).toBeCloseTo(0.5, 1);
    // ...no part consumed yet at the halfway point.
    const bearingMid = Object.values(world.state.items)
      .filter((i) => i.defId === W5.bearing && i.stacking === "stack")
      .reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 0), 0);
    expect(bearingMid).toBe(2);

    // ...then a different worker (the tech, who actually carries the part) finishes it.
    const finished = completeStage(recipeCtx, repairTaskId, techId);
    expect(finished.status).toBe("recipeComplete");
    expect(finished.status === "recipeComplete" && finished.events.map((e) => e.type)).toContain(
      "faultRepaired",
    );

    const engine = byDef(world, W5.engine);
    expect(engine.faults).toEqual([]);
    expect(engine.condition).toBeGreaterThan(0.9); // restored, was already ~1
    expect(world.state.work.problems[fault.id]?.status).toBe("resolved");

    const bearingAfter = Object.values(world.state.items)
      .filter((i) => i.defId === W5.bearing && i.stacking === "stack")
      .reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 0), 0);
    expect(bearingAfter).toBe(1); // consumed exactly once
  });

  it("survives a save/restore mid-repair", () => {
    const { kernel, world } = w5TestWorld();
    const techId = Object.keys(world.state.actors)[0] as ActorId;
    const machineId = injectEngineFault(world, kernel);
    const symptom = Object.values(world.state.work.problems).find(
      (p): p is ProblemOfKind<"machineSymptom"> =>
        p.kind === "machineSymptom" && p.payload.machineId === machineId,
    ) as ProblemOfKind<"machineSymptom">;
    const inspectSpecs = equipmentTaskDerivation.machineSymptom?.(symptom, ctxOf(world)) ?? [];
    const inspectTaskId = installTask(world, symptom.id, inspectSpecs[0] as TaskSpec);
    const recipeCtx = {
      state: world.state,
      content: world.content,
      config: world.config.values,
      tick: world.state.tick,
    };

    advanceStage(recipeCtx, inspectTaskId, techId, 10 * 20); // half of the 20s diagnosis

    const envelope = kernel.serialize(world);
    const restored = kernel.restore(envelope, world.content);
    const restoredEngine = byDef(restored, W5.engine);
    expect(restoredEngine.faults[0]?.repairStepProgress).toBeCloseTo(0.5, 1);

    const restoredCtx = {
      state: restored.state,
      content: restored.content,
      config: restored.config.values,
      tick: restored.state.tick,
    };
    const done = advanceStage(restoredCtx, inspectTaskId, techId, 10 * 20);
    expect(done.status).toBe("recipeComplete");
  });
});
