/**
 * Integration: the kernel over the tiny bundle with only core systems registered.
 */
import { describe, expect, it } from "vitest";
import { kernel as exportedKernel } from "../index";
import { cmd, tinyTestWorld } from "./fixtures/test-world";
import { TINY, tinyConfig, tinyContent, tinyEffectiveConfig } from "./fixtures/tiny-content";
import { checkInvariants } from "./invariants";
import type { HookId } from "./types/ids";

describe("kernel integration", () => {
  it("creates the scenario world through the command path", () => {
    const { world, kernel } = tinyTestWorld();
    const { state } = world;
    expect(state.tick).toBe(0);
    expect(Object.keys(state.compartments)).toHaveLength(2);
    expect(Object.keys(state.doors)).toHaveLength(1);
    expect(Object.keys(state.machines)).toHaveLength(1);
    expect(Object.values(state.actors).map((a) => [a.id, a.name, a.location])).toEqual([
      ["a1", "Mara Voss", { kind: "onDeck", deckId: TINY.deck, x: 1.5, y: 1.5 }],
    ]);
    const items = Object.values(state.items).map((i) => [i.defId, i.location.kind]);
    expect(items).toEqual([
      [TINY.rations, "carriedBy"],
      [TINY.wrench, "onDeck"],
    ]);
    expect(state.money.balance).toBe(500);
    expect(state.travel).toEqual({ stage: "docked", portId: TINY.port });
    expect(state.commands.recentIds).toEqual([`cmd:scenario:${TINY.scenario}:0`]);
    expect(checkInvariants(state)).toEqual([]);
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
    expect(kernel.getRenderFrame(world).actors).toHaveLength(1);
  });

  it("advances 200 ticks with clean invariants every step, and survives save/restore", () => {
    const { world, kernel } = tinyTestWorld();
    for (let i = 0; i < 200; i++) {
      const result = kernel.advance(world, 1);
      expect(result.ticksAdvanced).toBe(1);
      expect(checkInvariants(world.state)).toEqual([]);
    }
    expect(world.state.tick).toBe(200);

    const restored = kernel.restore(
      JSON.parse(JSON.stringify(kernel.serialize(world))),
      world.content,
    );
    const more = kernel.advance(restored, 50);
    expect(more).toMatchObject({ ticksAdvanced: 50, halt: { kind: "completed" } });
    expect(restored.state.tick).toBe(250);
    expect(checkInvariants(restored.state)).toEqual([]);
  });

  it("halts on the quiet-too-long hook and resumes after acknowledgeHook", () => {
    const { world, kernel } = tinyTestWorld({ quietTooLongSeconds: 2 });
    const first = kernel.advance(world, 200);
    expect(first).toMatchObject({ ticksAdvanced: 40, halt: { kind: "hook" } });
    expect(kernel.advance(world, 200)).toMatchObject({ ticksAdvanced: 0, halt: { kind: "hook" } });

    const hookId = world.state.narrator.pendingHook?.id as HookId;
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
    );
    const resumed = kernel.advance(world, 30);
    expect(resumed).toMatchObject({ ticksAdvanced: 30, halt: { kind: "completed" } });
    expect(world.state.tick).toBe(70);
    expect(checkInvariants(world.state)).toEqual([]);
  });

  it("builds a render frame with labelled actors, machines, doors and money", () => {
    const { world, kernel } = tinyTestWorld();
    kernel.advance(world, 5);
    const frame = kernel.getRenderFrame(world);
    expect(frame.tick).toBe(5);
    expect(frame.actors).toEqual([
      {
        id: "a1",
        name: "Mara Voss",
        deckId: TINY.deck,
        x: 1.5,
        y: 1.5,
        onDock: false,
        facing: 0,
        actionLabel: "idle",
        passenger: false,
        wounded: false,
      },
    ]);
    expect(frame.machines).toEqual([
      { id: "m1", state: "ok", temperatureNorm: 0, deckId: TINY.deck, placementKey: "pump1" },
    ]);
    expect(frame.doors).toEqual([
      {
        id: "d1",
        physicalState: "closed",
        openFraction: 0,
        deckId: TINY.deck,
        placementKey: "holdDoor",
      },
    ]);
    expect(frame.travel).toEqual({
      state: "docked",
      progress: 0,
      fromPortId: TINY.port,
      toPortId: TINY.port,
      drifting: false,
    });
    expect(frame.money).toBe(500);
    expect(frame.tickerEvents).toEqual([]);

    const actor = world.state.actors["a1" as never];
    if (actor === undefined) throw new Error("no actor");
    actor.activity = {
      kind: "task",
      taskId: "t1" as never,
      claimId: "l1" as never,
      urgency: "routineObligation",
      action: {
        kind: "repair",
        stage: "working",
        targetId: "m1" as never,
        progress: 0,
        startedTick: 5,
        interruptible: true,
      },
      sinceTick: 5,
    };
    expect(kernel.getRenderFrame(world).actors[0]?.actionLabel).toBe("repairing coolant pump");
    expect(structuredCloneable(frame)).toBe(true);
  });

  it("puts notable events from the last advance on the ticker", () => {
    const { world, kernel, registry } = tinyTestWorld();
    registry.registerSystem({
      name: "test.noticer",
      phase: "perception",
      run: (ctx) => {
        if (ctx.tick !== 2) return;
        ctx.emit({
          type: "faultObserved",
          subjectIds: ["a1" as never, "m1" as never],
          causeIds: [],
          source: "sim",
          payload: { machineId: "m1" as never, symptomKey: "grinding" },
        });
      },
    });
    kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scenarioInjectFault",
        payload: { machineId: "m1" as never, faultKey: "seized" },
      }),
    );
    kernel.advance(world, 3);
    const frame = kernel.getRenderFrame(world);
    expect(frame.machines[0]?.state).toBe("failed");
    // commandApplied is trace-level and hidden; faultOccurred is trace but on the ticker
    // allowlist (Integration 2), and the observation is notable.
    expect(frame.tickerEvents).toEqual([
      { tick: 1, text: "Coolant Pump: seized", significance: "trace" },
      {
        tick: 2,
        text: "Mara Voss noticed grinding from the coolant pump",
        significance: "notable",
      },
    ]);
    kernel.advance(world, 1);
    expect(kernel.getRenderFrame(world).tickerEvents).toEqual([]);
  });

  it("is exported from the package entry point", () => {
    const config = tinyConfig();
    const world = exportedKernel.createWorld(
      TINY.scenario,
      1,
      tinyContent(config),
      tinyEffectiveConfig(config),
    );
    expect(exportedKernel.advance(world, 3).ticksAdvanced).toBe(3);
    expect(() => exportedKernel.getAgentView(world, "a1" as never)).toThrow(/not implemented/);
  });
});

function structuredCloneable(value: unknown): boolean {
  return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value);
}
