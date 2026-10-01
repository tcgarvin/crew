/**
 * Travel state machine tests (PLAN §6 W6 "Tests"). Only `registerTravel`/`registerCommerce` are
 * registered (no spatial/equipment/power), so ramps start already closed, engines start `on` at
 * full output, and staffing is untested here (no `pilotStation` machine in the fixture).
 */
import { describe, expect, it } from "vitest";
import type { Command } from "../../core/types/commands";
import type { CommandId, HookId } from "../../core/types/ids";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "./fixtures";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:travel-test:${counter}` as CommandId };
}

describe("travel state machine", () => {
  it("runs docked -> ... -> docked at the destination with correct stage durations", () => {
    const { world, kernel } = freightTestWorld();
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.a });

    const setCourse = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    expect(setCourse.status).toBe("accepted");

    const first = kernel.advance(world, 1);
    expect(first.halt).toEqual({ kind: "completed" });
    expect(world.state.travel.stage).toBe("preparingDeparture");

    // prepare(1s) + undock(1s) + depart(1s) = 60 ticks before transit begins.
    kernel.advance(world, 60 - 1);
    expect(world.state.travel).toMatchObject({
      stage: "transit",
      fromPortId: PORTS.a,
      toPortId: PORTS.b,
    });

    // transit: distance 25 / nominalSpeed 5 = 5s = 100 ticks, then approach raises the hook.
    const untilHook = kernel.advance(world, 1000);
    expect(untilHook.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("approachingPort");
    expect(world.state.travel.stage).toBe("approaching");

    const hookId = world.state.narrator.pendingHook?.id as HookId;
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
    );
    // Docking at B with nothing on raises `jobBoard` (D40); acknowledge that too.
    const after = advanceThroughHooks(kernel, world, 1000);
    expect(after.halt).toEqual({ kind: "completed" });
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.b });
  });

  it("rejects setCourse while not docked", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    kernel.advance(world, 1);
    expect(world.state.travel.stage).toBe("preparingDeparture");

    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.c } }),
    );
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "preconditionFailed" } });
  });

  it("rejects setCourse to the current port or an unknown port", () => {
    const { world, kernel } = freightTestWorld();
    expect(
      kernel.enqueueCommand(
        world,
        cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.a } }),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      kernel.enqueueCommand(
        world,
        cmd({
          source: "player",
          kind: "setCourse",
          payload: { destinationPortId: "port.nope" as never },
        }),
      ),
    ).toMatchObject({ status: "rejected", rejection: { code: "unknownEntity" } });
  });

  it("stalls transit while the engine is off, then resumes from the same progress", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    kernel.advance(world, 60); // through prepare/undock/depart into transit
    expect(world.state.travel.stage).toBe("transit");

    kernel.advance(world, 20); // 1s of nominal transit: routeProgress should have grown
    const progress = (world.state.travel as { routeProgress: number }).routeProgress;
    expect(progress).toBeGreaterThan(0);

    const engine = Object.values(world.state.machines).find((m) => m.defId === FIX.engine);
    if (engine === undefined) throw new Error("engine missing");
    engine.actualMode = "off";
    kernel.advance(world, 40);
    expect((world.state.travel as { routeProgress: number }).routeProgress).toBe(progress);
    expect((world.state.travel as { drifting: boolean }).drifting).toBe(true);

    engine.actualMode = "on";
    kernel.advance(world, 20);
    const resumed = (world.state.travel as { routeProgress: number }).routeProgress;
    expect(resumed).toBeGreaterThan(progress);
    expect((world.state.travel as { drifting: boolean }).drifting).toBe(false);
  });

  it("survives save/restore mid-transit with identical progress", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    kernel.advance(world, 90);
    expect(world.state.travel.stage).toBe("transit");
    const before = JSON.parse(JSON.stringify(world.state.travel));

    const saved = JSON.parse(JSON.stringify(kernel.serialize(world)));
    const restored = kernel.restore(saved, world.content);
    expect(restored.state.travel).toEqual(before);

    kernel.advance(world, 10);
    kernel.advance(restored, 10);
    expect(restored.state.travel).toEqual(world.state.travel);
  });
});

// ---------------------------------------------------------------------------------------------
// D36 departure gate
// ---------------------------------------------------------------------------------------------

type GateWorld = ReturnType<typeof freightTestWorld>;

function theEngine(world: GateWorld["world"]) {
  const engine = Object.values(world.state.machines).find((m) => m.defId === FIX.engine);
  if (engine === undefined) throw new Error("engine missing");
  return engine;
}

function addFault(world: GateWorld["world"], faultKey: string) {
  theEngine(world).faults.push({
    faultKey,
    sinceTick: world.state.tick,
    diagnosed: false,
    repairStepIndex: 0,
    repairStepProgress: 0,
  });
}

function setCourseTo(kernel: GateWorld["kernel"], world: GateWorld["world"], portId: string) {
  const result = kernel.enqueueCommand(
    world,
    cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: portId as never } }),
  );
  expect(result.status).toBe("accepted");
}

function pendingGate(world: GateWorld["world"]) {
  const head = world.state.decisions.queue[0];
  const decision = head === undefined ? undefined : world.state.decisions.records[head];
  return decision?.prompt.key === "travel.departureGate" ? decision : undefined;
}

function resolveGate(
  kernel: GateWorld["kernel"],
  world: GateWorld["world"],
  side: "left" | "right",
) {
  const decision = pendingGate(world);
  if (decision === undefined) throw new Error("no gate decision pending");
  const result = kernel.enqueueCommand(
    world,
    cmd({
      source: "player",
      kind: "resolveDecision",
      payload: { decisionId: decision.id, side },
    }),
  );
  expect(result.status).toBe("accepted");
}

/**
 * D37: a policy decision halts on its `policyDecision` hook first; once the host acknowledges it
 * the decision halt follows without another tick. Returns the hook-raising advance.
 */
function expectGateAsked(kernel: GateWorld["kernel"], world: GateWorld["world"], ticks = 10) {
  const halted = kernel.advance(world, ticks);
  expect(halted.halt).toEqual({ kind: "hook" });
  const hook = world.state.narrator.pendingHook;
  const decision = pendingGate(world);
  expect(decision).toBeDefined();
  expect(hook).toMatchObject({
    kind: "policyDecision",
    context: { decisionId: decision?.id, machineId: theEngine(world).id },
  });
  expect(decision?.narratorHookId).toBe(hook?.id);
  kernel.enqueueCommand(
    world,
    cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook?.id as HookId } }),
  );
  expect(kernel.advance(world, ticks)).toMatchObject({
    ticksAdvanced: 0,
    halt: { kind: "decision" },
  });
  return halted;
}

describe("departure gate (D36)", () => {
  it("raises one policy decision for an engine with an unrepaired derating fault and stays put", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    setCourseTo(kernel, world, PORTS.b);

    const halted = expectGateAsked(kernel, world, 200);
    expect(world.state.travel.stage).toBe("preparingDeparture");
    expect(halted.events.some((e) => e.type === "policyDecisionNeeded")).toBe(true);
    // D37: the hook and the announcement are raised in the same tick, hook first.
    const types = halted.events.map((e) => e.type);
    expect(types.indexOf("narratorHookRaised")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("narratorHookRaised")).toBeLessThan(types.indexOf("decisionPending"));

    const decision = pendingGate(world);
    expect(decision).toBeDefined();
    expect(decision?.origin).toBe("policy");
    expect(decision?.prompt.params).toMatchObject({
      machineId: theEngine(world).id,
      machine: "Main Engine",
      reason: "fault",
      speaker: "First Officer Kade", // the crew member tagged engineer (D29)
    });
    expect(decision?.left.commands[0]?.kind).toBe("holdDepartureForRepairs");
    expect(decision?.right.commands[0]?.kind).toBe("acceptDepartureRisk");
    expect(world.state.decisions.queue).toHaveLength(1);
  });

  it("asks while docked with a planned destination, before departure prep begins", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    world.state.travel = { stage: "docked", portId: PORTS.a, plannedDestinationId: PORTS.b };

    expectGateAsked(kernel, world, 50);
    expect(world.state.travel.stage).toBe("docked");
  });

  it("narrates the gate even when another hook was pending the tick it was raised (D37)", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    world.state.travel = { stage: "docked", portId: PORTS.a, plannedDestinationId: PORTS.b };
    // Make the quiet timer fire on the very next tick, ahead of the gate in the same tick.
    world.state.narrator.lastNarrativeTick = -1_000_000;

    const first = kernel.advance(world, 50);
    expect(first.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("quietTooLong");
    const gate = pendingGate(world);
    expect(gate).toBeDefined();
    expect(gate?.narratorHookId).toBeUndefined();

    // Acknowledging the quiet hook does not show the card: the next tick raises the gate's hook.
    const quietId = world.state.narrator.pendingHook?.id as HookId;
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: quietId } }),
    );
    expect(kernel.advance(world, 0).halt).toEqual({ kind: "completed" });
    expectGateAsked(kernel, world, 50);
    expect(pendingGate(world)?.id).toBe(gate?.id);
  });

  it("'Leave anyway' departs, never asks again that docking, and is forgotten at the next dock", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    setCourseTo(kernel, world, PORTS.b);
    expectGateAsked(kernel, world);

    resolveGate(kernel, world, "right");
    const departing = kernel.advance(world, 60);
    expect(departing.halt).toEqual({ kind: "completed" });
    expect(departing.events.some((e) => e.type === "departureRiskAccepted")).toBe(true);
    expect(departing.events.some((e) => e.type === "departed")).toBe(true);
    expect(world.state.travel.stage).toBe("transit");
    expect(world.state.decisions.queue).toEqual([]);

    // Through approach (hook) and arrival at B: the flag does not survive the docking.
    const untilHook = kernel.advance(world, 1000);
    expect(untilHook.halt).toEqual({ kind: "hook" });
    const hookId = world.state.narrator.pendingHook?.id as HookId;
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
    );
    expect(advanceThroughHooks(kernel, world, 1000).halt).toEqual({ kind: "completed" });
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.b });

    // The fault is still there, so the next planned departure asks again.
    setCourseTo(kernel, world, PORTS.a);
    expectGateAsked(kernel, world);
  });

  it("'Hold for repairs' waits, then departs on its own with an event once the fault is cleared", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    setCourseTo(kernel, world, PORTS.b);
    expectGateAsked(kernel, world);

    resolveGate(kernel, world, "left");
    const holding = kernel.advance(world, 200);
    expect(holding.halt).toEqual({ kind: "completed" });
    expect(holding.events.some((e) => e.type === "departureHeld")).toBe(true);
    expect(world.state.travel.stage).toBe("preparingDeparture");
    expect(world.state.travel.holdForRepairs).toBe(true);
    expect(world.state.decisions.queue).toEqual([]); // no second ask while holding

    theEngine(world).faults = [];
    const released = kernel.advance(world, 60);
    expect(released.halt).toEqual({ kind: "completed" });
    const lifted = released.events.find((e) => e.type === "departureHoldLifted");
    expect(lifted).toMatchObject({ significance: "narrative", payload: { toPortId: PORTS.b } });
    expect(released.events.some((e) => e.type === "departed")).toBe(true);
    expect(world.state.travel.stage).toBe("transit");
    expect(world.state.travel.holdForRepairs).toBeUndefined();
  });

  it("does not ask for a healthy ship, a symptom-only fault, or integrity above the derate threshold", () => {
    for (const setup of [
      () => undefined,
      (world: GateWorld["world"]) => addFault(world, "hotPanel"),
      (world: GateWorld["world"]) => {
        theEngine(world).integrity = 0.7;
      },
    ]) {
      const { world, kernel } = freightTestWorld();
      setup(world);
      setCourseTo(kernel, world, PORTS.b);
      const result = kernel.advance(world, 60);
      expect(result.halt).toEqual({ kind: "completed" });
      expect(world.state.decisions.queue).toEqual([]);
      expect(world.state.travel.stage).toBe("transit");
    }
  });

  it("asks when output is below departureMinOutput, naming the low output", () => {
    const { world, kernel } = freightTestWorld();
    theEngine(world).output = 0.3;
    setCourseTo(kernel, world, PORTS.b);
    expectGateAsked(kernel, world);
    expect(pendingGate(world)?.prompt.params.reason).toBe("lowOutput");
  });
});
