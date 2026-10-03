import { describe, expect, it } from "vitest";
import { queuePolicyDecision } from "./decisions";
import { cmd, tinyTestWorld } from "./fixtures/test-world";
import { TINY } from "./fixtures/tiny-content";
import { raiseHookIfIdle } from "./hooks";
import { dueActors, isStaggerDue, runStep } from "./pipeline";
import { NotImplementedError } from "./registry";
import type { ActorId, HookId } from "./types/ids";
import type { World } from "./types/kernel";
import { PHASES, type Phase, type StepCtx } from "./types/pipeline";
import type { AgentView } from "./types/view";

function spawnExtraActors(
  world: World,
  kernel: ReturnType<typeof tinyTestWorld>["kernel"],
  n: number,
) {
  kernel.enqueueCommand(
    world,
    cmd({
      source: "scenario",
      kind: "scenarioSpawn",
      payload: {
        spawns: Array.from({ length: n }, (_, i) => ({
          kind: "actor" as const,
          tempRef: `$extra${i}` as const,
          crewDefId: "crew.tiny.mara" as never,
          location: { kind: "onDeck" as const, deckId: "deck.tiny.main" as never, x: 0.5, y: 0.5 },
        })),
      },
    }),
  );
  kernel.advance(world, 1);
}

describe("pipeline order and cadence", () => {
  it("runs systems in PHASES order, stable within a phase", () => {
    const { world, registry } = tinyTestWorld();
    const ran: string[] = [];
    const record = (name: string, phase: Phase) =>
      registry.registerSystem({ name, phase, run: () => ran.push(name) });
    for (const phase of [...PHASES].reverse()) record(`${phase}.first`, phase);
    record("actions.second", "actions");
    runStep(world, registry);
    expect(ran).toEqual([
      "inputs.first",
      "topology.first",
      "actions.first",
      "actions.second",
      "equipment.first",
      "needs.first",
      "perception.first",
      "planning.first",
      "finalize.first",
    ]);
    const core = registry.pipeline().map((e) => (e.kind === "system" ? e.name : "planner"));
    expect(core.indexOf("core.commands")).toBe(0);
  });

  it("runs an every-N system on multiples of N with elapsedTicks N", () => {
    const { world, registry } = tinyTestWorld();
    const runs: [number, number][] = [];
    registry.registerSystem({
      name: "slow",
      phase: "equipment",
      every: 3,
      run: (ctx) => runs.push([ctx.tick, ctx.elapsedTicks]),
    });
    for (let i = 0; i < 9; i++) runStep(world, registry);
    expect(runs).toEqual([
      [3, 3],
      [6, 3],
      [9, 3],
    ]);
    expect(() =>
      registry.registerSystem({ name: "bad", phase: "needs", every: 0, run: () => {} }),
    ).toThrow(RangeError);
  });

  it("staggers an actor system so each actor is due once per window", () => {
    expect([0, 1, 2, 3, 4].map((i) => isStaggerDue(7, i, 3))).toEqual([
      false,
      true,
      false,
      false,
      true,
    ]);
    const ids = ["a1", "a2", "a3"] as ActorId[];
    expect(dueActors(ids, 3, 3)).toEqual(["a1"]);
    expect(dueActors(ids, 4, 3)).toEqual(["a2"]);
    expect(dueActors(ids, 5, 3)).toEqual(["a3"]);

    const { world, kernel, registry } = tinyTestWorld();
    spawnExtraActors(world, kernel, 2);
    const seen: Record<string, number[]> = {};
    registry.registerSystem({
      name: "staggered",
      phase: "needs",
      every: 3,
      staggerBy: "actor",
      run: (ctx: StepCtx) => {
        expect(ctx.elapsedTicks).toBe(3);
        for (const id of ctx.dueActorIds ?? []) seen[id] = [...(seen[id] ?? []), ctx.tick];
      },
    });
    for (let i = 0; i < 6; i++) runStep(world, registry); // ticks 2..7
    expect(seen).toEqual({ a1: [3, 6], a2: [4, 7], a3: [2, 5] });
  });
});

describe("planner stage", () => {
  it("is a no-op with no planner registered, even without an AgentView builder", () => {
    const { world, registry } = tinyTestWorld();
    expect(() => {
      for (let i = 0; i < 20; i++) runStep(world, registry);
    }).not.toThrow();
  });

  it("throws NotImplemented when a planner runs before the AgentView builder exists", () => {
    const { world, registry } = tinyTestWorld();
    registry.registerPlanner(() => ({ kind: "idle" }));
    expect(() => {
      for (let i = 0; i < 10; i++) runStep(world, registry);
    }).toThrow(NotImplementedError);
  });

  it("stores the planner's intent on due actors on the reconsider cadence", () => {
    const { world, registry } = tinyTestWorld();
    const planned: [number, string][] = [];
    registry.setAgentViewBuilder(
      (w, actorId) => ({ tick: w.state.tick, self: { id: actorId } }) as unknown as AgentView,
    );
    registry.registerPlanner((view) => {
      planned.push([view.tick, view.self.id]);
      return {
        kind: "personal",
        activity: "rest",
        urgency: "voluntaryActivity",
        trace: { candidates: 1, chosenReason: "test", rejected: [] },
      };
    });
    for (let i = 0; i < 20; i++) runStep(world, registry);
    // One actor (index 0), reconsiderEveryTicks = 10: due on ticks 10 and 20.
    expect(planned).toEqual([
      [9, "a1"],
      [19, "a1"],
    ]);
    const actor = world.state.actors["a1" as ActorId];
    expect(actor?.pendingIntent).toMatchObject({ kind: "personal", activity: "rest" });
    expect(actor?.lastPlannedTick).toBe(20);
    expect(world.caches.diagnostics.plannerTraces).toHaveLength(2);
  });
});

function acknowledge(
  kernel: ReturnType<typeof tinyTestWorld>["kernel"],
  world: World,
  hookId: HookId | undefined,
) {
  const ack = kernel.enqueueCommand(
    world,
    cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: hookId as HookId } }),
  );
  expect(ack.status).toBe("accepted");
}

describe("quiet-too-long timer", () => {
  it("raises exactly once, halts advance, and pauses until acknowledged", () => {
    // 1 s at 20 ticks/s: fires once 20 ticks have passed without a narrative event.
    const { world, kernel } = tinyTestWorld({ quietTooLongSeconds: 1 });
    const first = kernel.advance(world, 200);
    expect(first).toMatchObject({ ticksAdvanced: 20, halt: { kind: "hook" } });
    const raised = first.events.filter((e) => e.type === "narratorHookRaised");
    expect(raised).toHaveLength(1);
    const hook = world.state.narrator.pendingHook;
    expect(hook).toMatchObject({ kind: "quietTooLong", tick: 20, context: { quietSinceTick: 0 } });

    const paused = kernel.advance(world, 50);
    expect(paused).toMatchObject({ ticksAdvanced: 0, events: [], halt: { kind: "hook" } });
    expect(world.state.tick).toBe(20);

    const ack = kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook?.id as HookId } }),
    );
    expect(ack.status).toBe("accepted");
    const resumed = kernel.advance(world, 10);
    expect(resumed).toMatchObject({ ticksAdvanced: 10, halt: { kind: "completed" } });
    expect(resumed.events.map((e) => e.type)).toContain("narratorHookResolved");
    expect(world.state.narrator.pendingHook).toBeUndefined();
    expect(world.state.narrator.recentHookIds).toEqual([hook?.id]);

    // Re-armed from the raise tick: the next hook comes a full window later.
    const next = kernel.advance(world, 200);
    expect(next).toMatchObject({ ticksAdvanced: 10, halt: { kind: "hook" } });
    expect(world.state.narrator.pendingHook?.tick).toBe(40);
  });

  it("is reset by a narrative event from an earlier tick", () => {
    const { world, kernel, registry } = tinyTestWorld({ quietTooLongSeconds: 1 });
    registry.registerSystem({
      name: "storyBeat",
      phase: "equipment",
      run: (ctx) => {
        if (ctx.tick === 15) {
          ctx.emit({
            type: "arrived",
            subjectIds: [],
            causeIds: [],
            source: "sim",
            payload: { portId: "port.tiny.dock" as never },
          });
        }
      },
    });
    const result = kernel.advance(world, 200);
    expect(world.state.narrator.lastNarrativeTick).toBe(35);
    expect(result.ticksAdvanced).toBe(35);
    expect(world.state.narrator.pendingHook?.context).toEqual({ quietSinceTick: 15 });
  });

  it("does not fire within quietTooLongSeconds of another hook (jobBoard here)", () => {
    // Any hook raised is narrator contact: the quiet window restarts from its raise tick.
    const { world, kernel, registry } = tinyTestWorld({ quietTooLongSeconds: 1 });
    registry.registerSystem({
      name: "approach",
      phase: "equipment",
      run: (ctx) => {
        if (ctx.tick === 15) raiseHookIfIdle(ctx, "jobBoard", { portId: TINY.port });
      },
    });
    const approach = kernel.advance(world, 200);
    expect(approach).toMatchObject({ ticksAdvanced: 15, halt: { kind: "hook" } });
    const hook = world.state.narrator.pendingHook;
    expect(hook).toMatchObject({ kind: "jobBoard", tick: 15 });
    expect(world.state.narrator.lastNarrativeTick).toBe(15);
    acknowledge(kernel, world, hook?.id);

    const quiet = kernel.advance(world, 200);
    // 15 + 20 ticks: a full window after the approach, not 20 after tick 0.
    expect(quiet).toMatchObject({ ticksAdvanced: 20, halt: { kind: "hook" } });
    expect(world.state.narrator.pendingHook).toMatchObject({
      kind: "quietTooLong",
      tick: 35,
      context: { quietSinceTick: 15 },
    });
  });

  it("yields to another hook raised in the same tick, so one tick raises one hook", () => {
    const { world, kernel, registry } = tinyTestWorld({ quietTooLongSeconds: 1 });
    registry.registerSystem({
      name: "approach",
      phase: "equipment",
      run: (ctx) => {
        // Tick 20 is exactly when the quiet timer is due.
        if (ctx.tick === 20) raiseHookIfIdle(ctx, "jobBoard", { portId: TINY.port });
      },
    });
    const result = kernel.advance(world, 200);
    expect(result).toMatchObject({ ticksAdvanced: 20, halt: { kind: "hook" } });
    expect(result.events.filter((e) => e.type === "narratorHookRaised")).toHaveLength(1);
    const hook = world.state.narrator.pendingHook;
    expect(hook).toMatchObject({ kind: "jobBoard", tick: 20 });
    acknowledge(kernel, world, hook?.id);

    const next = kernel.advance(world, 200);
    expect(next.events.filter((e) => e.type === "narratorHookRaised")).toHaveLength(1);
    expect(world.state.narrator.pendingHook).toMatchObject({ kind: "quietTooLong", tick: 40 });
  });

  it("yields to a policyDecision hook raised in the same tick", () => {
    const { world, kernel, registry } = tinyTestWorld({ quietTooLongSeconds: 1 });
    registry.registerSystem({
      name: "card",
      phase: "equipment",
      run: (ctx) => {
        if (ctx.tick !== 20) return;
        const actorId = Object.keys(ctx.state.actors)[0] as ActorId;
        queuePolicyDecision(ctx, {
          perspectiveActorId: actorId,
          prompt: { key: "test.card", params: {} },
          left: { label: { key: "test.left", params: {} }, commands: [] },
          right: { label: { key: "test.right", params: {} }, commands: [] },
        });
      },
    });
    const result = kernel.advance(world, 200);
    expect(result).toMatchObject({ ticksAdvanced: 20, halt: { kind: "hook" } });
    expect(result.events.filter((e) => e.type === "narratorHookRaised")).toHaveLength(1);
    expect(world.state.narrator.pendingHook).toMatchObject({ kind: "policyDecision", tick: 20 });
  });

  it("rejects acknowledging a hook that is not pending", () => {
    const { world, kernel } = tinyTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: "k9" as HookId } }),
    );
    expect(result.status === "rejected" && result.rejection.code).toBe("preconditionFailed");
  });
});
