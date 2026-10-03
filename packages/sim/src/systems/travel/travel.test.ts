/**
 * Travel state machine tests (PLAN §6 W6 "Tests"). Only `registerTravel`/`registerCommerce` are
 * registered (no spatial/equipment/power), so ramps start already closed, engines start `on` at
 * full output, and staffing is untested here (no `pilotStation` machine in the fixture).
 */
import { describe, expect, it } from "vitest";
import type { Command } from "../../core/types/commands";
import type { CommandId, HookId } from "../../core/types/ids";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "./fixtures";
import { raiseHookIfIdle } from "./hooks";

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
    const { world, kernel, registry } = freightTestWorld();
    addFault(world, "wornBearing");
    world.state.travel = { stage: "docked", portId: PORTS.a, plannedDestinationId: PORTS.b };
    // Another hook raised earlier in the same tick (phase 2 runs before travel's phase 4), so
    // the gate's own hook has to wait. (The quiet timer runs last in the tick since the pacing
    // follow-up, so it can no longer be the hook that gets ahead of the gate.)
    registry.registerSystem({
      name: "earlyHook",
      phase: "topology",
      run: (ctx) => {
        if (ctx.tick === 1)
          raiseHookIfIdle(ctx, "approachingPort", { portId: PORTS.a, etaTicks: 5 });
      },
    });

    const first = kernel.advance(world, 50);
    expect(first.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("approachingPort");
    const gate = pendingGate(world);
    expect(gate).toBeDefined();
    expect(gate?.narratorHookId).toBeUndefined();

    // Acknowledging the other hook does not show the card: the next tick raises the gate's hook.
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
    // D47: holding means waiting docked, course kept, so the crew can reach the port market.
    expect(world.state.travel).toEqual({
      stage: "docked",
      portId: PORTS.a,
      plannedDestinationId: PORTS.b,
      holdForRepairs: true,
    });
    expect(world.state.decisions.queue).toEqual([]); // no second ask while holding

    theEngine(world).faults = [];
    // Docked again (D47), so the lift runs the whole prep/undock/depart sequence from the ramp.
    const released = kernel.advance(world, 160);
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

// ---------------------------------------------------------------------------------------------
// Voyages (passengers-and-galaxy §2.3)
// ---------------------------------------------------------------------------------------------

type VoyageKernel = GateWorld["kernel"];
type VoyageWorld = GateWorld["world"];

/**
 * Advance in short steps until `done` holds or `maxTicks` run out, acknowledging every hook on
 * the way and recording its kind; stops at a decision halt so the test can resolve it.
 */
function advanceUntil(
  kernel: VoyageKernel,
  world: VoyageWorld,
  done: (world: VoyageWorld) => boolean,
  maxTicks = 2000,
): { hooks: string[]; haltedOnDecision: boolean } {
  const hooks: string[] = [];
  let remaining = maxTicks;
  while (remaining > 0 && !done(world)) {
    const result = kernel.advance(world, Math.min(remaining, 20));
    remaining -= result.ticksAdvanced;
    if (result.halt.kind === "decision") return { hooks, haltedOnDecision: true };
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      hooks.push(hook.kind);
      kernel.enqueueCommand(
        world,
        cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } }),
      );
    }
  }
  return { hooks, haltedOnDecision: false };
}

const dockedAt = (portId: string) => (world: VoyageWorld) =>
  world.state.travel.stage === "docked" && world.state.travel.portId === portId;

function openProblem(world: VoyageWorld, problem: Record<string, unknown>) {
  const id = `problem:test:${counter++}`;
  world.state.work.problems[id as never] = {
    id,
    owner: "commerce",
    visibility: "public",
    dedupeKey: id,
    status: "open",
    createdTick: world.state.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "port", portId: PORTS.c },
    ...problem,
  } as never;
  return id;
}

function resolveProblem(world: VoyageWorld, id: string) {
  const problem = world.state.work.problems[id as never];
  if (problem === undefined) throw new Error("problem missing");
  problem.status = "resolved";
}

describe("voyages: a destination beyond one hop (§2.3)", () => {
  it("setCourse to a two-hop port sets the voyage and flies the first hop of the shortest path", () => {
    const { world, kernel } = freightTestWorld();
    setCourseTo(kernel, world, PORTS.d);
    kernel.advance(world, 1);
    expect(world.state.travel).toMatchObject({
      stage: "preparingDeparture",
      fromPortId: PORTS.a,
      toPortId: PORTS.c,
      routeDistance: 45,
      voyageDestinationId: PORTS.d,
    });
  });

  it("setCourse to a neighbour sets no voyage, as before", () => {
    const { world, kernel } = freightTestWorld();
    setCourseTo(kernel, world, PORTS.b);
    kernel.advance(world, 1);
    expect(world.state.travel.stage).toBe("preparingDeparture");
    expect(world.state.travel.voyageDestinationId).toBeUndefined();
  });

  it("accepting a job to a far port through the offer card starts the voyage towards it", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "offerJob",
        payload: {
          surface: true,
          job: {
            issuer: "Delta Freight",
            description: { key: "test.job", params: {} },
            fromPortId: PORTS.a,
            toPortId: PORTS.d,
            cargo: [{ itemDefId: FIX.crate, count: 1 }],
            pay: 95, // 1 unit × path distance 95 × band min 1
          },
        },
      }),
    );
    kernel.advance(world, 1);
    const decisionId = world.state.decisions.queue[0];
    expect(decisionId).toBeDefined();
    kernel.enqueueCommand(
      world,
      cmd({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: decisionId as never, side: "left" },
      }),
    );
    kernel.advance(world, 1);
    // Cargo is still ashore, so the ship waits docked with the first hop planned.
    expect(world.state.travel).toMatchObject({
      stage: "docked",
      portId: PORTS.a,
      plannedDestinationId: PORTS.c,
      voyageDestinationId: PORTS.d,
    });
    expect(Object.values(world.state.jobs)[0]?.status).toBe("accepted");
  });

  it("docks at the waypoint for real (fee, arrival, approach hook), then plans the next hop on its own and ends the voyage at its destination", () => {
    const { world, kernel } = freightTestWorld({ dockingFee: 5 });
    setCourseTo(kernel, world, PORTS.d);

    const toC = advanceUntil(kernel, world, dockedAt(PORTS.c));
    expect(toC.haltedOnDecision).toBe(false);
    expect(toC.hooks).toContain("approachingPort");
    expect(world.state.money.balance).toBe(95);
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: PORTS.c });
    expect(world.state.travel.voyageDestinationId).toBe(PORTS.d);

    // The next tick plans the last hop with nothing holding the ship, and departure follows.
    kernel.advance(world, 1);
    expect(world.state.travel).toMatchObject({
      stage: "preparingDeparture",
      fromPortId: PORTS.c,
      toPortId: PORTS.d,
      voyageDestinationId: PORTS.d,
    });

    const toD = advanceUntil(kernel, world, dockedAt(PORTS.d));
    expect(toD.haltedOnDecision).toBe(false);
    // The waypoint is a stop on the way: the board was not asked there, only at the end.
    expect(toC.hooks).not.toContain("jobBoard");
    expect(world.state.money.balance).toBe(90);
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.d });
  });

  it("a detour to a neighbour keeps the voyage and routes on from where the ship ends up", () => {
    const { world, kernel } = freightTestWorld();
    world.state.travel = { stage: "docked", portId: PORTS.c, voyageDestinationId: PORTS.d };
    setCourseTo(kernel, world, PORTS.a);
    kernel.advance(world, 1);
    expect(world.state.travel).toMatchObject({
      stage: "preparingDeparture",
      toPortId: PORTS.a,
      voyageDestinationId: PORTS.d,
    });
    advanceUntil(kernel, world, dockedAt(PORTS.a));
    expect(world.state.travel.voyageDestinationId).toBe(PORTS.d);
    kernel.advance(world, 1);
    // From A the shortest way to D is back through C, not via B.
    expect(world.state.travel).toMatchObject({ stage: "preparingDeparture", toPortId: PORTS.c });
  });

  it("waits at the waypoint for a part the crew can buy here, then continues once it is settled", () => {
    const { world, kernel } = freightTestWorld();
    world.state.travel = { stage: "docked", portId: PORTS.c, voyageDestinationId: PORTS.d };
    world.state.markets[PORTS.c] = { [FIX.parts]: { count: 1, price: 10 } };
    const engine = theEngine(world);
    const problemId = openProblem(world, {
      kind: "partsNeeded",
      owner: "equipment",
      payload: { machineId: engine.id, itemDefId: FIX.parts, count: 1 },
      location: { kind: "machine", machineId: engine.id },
    });

    kernel.advance(world, 40);
    expect(world.state.travel).toEqual({
      stage: "docked",
      portId: PORTS.c,
      voyageDestinationId: PORTS.d,
    });

    resolveProblem(world, problemId);
    kernel.advance(world, 1);
    expect(world.state.travel).toMatchObject({ stage: "preparingDeparture", toPortId: PORTS.d });
  });

  it("does not wait for a part the market lacks or the ship cannot afford", () => {
    for (const market of [{}, { [FIX.parts]: { count: 1, price: 1000 } }]) {
      const { world, kernel } = freightTestWorld();
      world.state.travel = { stage: "docked", portId: PORTS.c, voyageDestinationId: PORTS.d };
      world.state.markets[PORTS.c] = market;
      const engine = theEngine(world);
      openProblem(world, {
        kind: "partsNeeded",
        owner: "equipment",
        payload: { machineId: engine.id, itemDefId: FIX.parts, count: 1 },
        location: { kind: "machine", machineId: engine.id },
      });
      kernel.advance(world, 1);
      expect(world.state.travel).toMatchObject({ stage: "preparingDeparture", toPortId: PORTS.d });
    }
  });

  it("waits at the waypoint for cargo work and for a pending card", () => {
    const { world, kernel } = freightTestWorld();
    world.state.travel = { stage: "docked", portId: PORTS.c, voyageDestinationId: PORTS.d };
    const cargo = openProblem(world, {
      kind: "cargoToUnload",
      payload: { jobId: "job:x", itemId: "item:x", portId: PORTS.c, storeKey: "warehouse" },
    });
    kernel.advance(world, 20);
    expect(world.state.travel.stage).toBe("docked");
    expect(world.state.travel.plannedDestinationId).toBeUndefined();

    resolveProblem(world, cargo);
    const decisionId = "decision:test:pending";
    world.state.decisions.records[decisionId as never] = {
      id: decisionId,
      origin: "narrator",
      perspectiveActorId: Object.keys(world.state.actors)[0],
      prompt: { key: "test.card", params: {} },
      left: { label: { key: "l", params: {} }, commands: [], aftermath: { key: "l", params: {} } },
      right: { label: { key: "r", params: {} }, commands: [], aftermath: { key: "r", params: {} } },
      status: "pending",
      createdTick: world.state.tick,
    } as never;
    world.state.decisions.queue.push(decisionId as never);
    expect(kernel.advance(world, 5).halt).toEqual({ kind: "decision" });
    expect(world.state.travel.stage).toBe("docked");
    expect(world.state.travel.plannedDestinationId).toBeUndefined();

    kernel.enqueueCommand(
      world,
      cmd({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: decisionId as never, side: "left" },
      }),
    );
    kernel.advance(world, 1);
    expect(world.state.travel).toMatchObject({ stage: "preparingDeparture", toPortId: PORTS.d });
  });

  it("drops a voyage whose destination can no longer be reached from here", () => {
    const { world, kernel } = freightTestWorld();
    world.state.travel = {
      stage: "docked",
      portId: PORTS.c,
      voyageDestinationId: "port.gone" as never,
    };
    kernel.advance(world, 1);
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.c });
  });

  it("survives save/restore mid-voyage, and a save from before voyages loads with none", () => {
    const { world, kernel } = freightTestWorld();
    setCourseTo(kernel, world, PORTS.d);
    kernel.advance(world, 90);
    const saved = JSON.parse(JSON.stringify(kernel.serialize(world)));
    expect(saved.state.travel.voyageDestinationId).toBe(PORTS.d);
    const restored = kernel.restore(saved, world.content);
    expect(restored.state.travel).toEqual(world.state.travel);

    const fresh = freightTestWorld();
    const oldSave = JSON.parse(JSON.stringify(fresh.kernel.serialize(fresh.world)));
    expect("voyageDestinationId" in oldSave.state.travel).toBe(false);
    const loaded = fresh.kernel.restore(oldSave, fresh.world.content);
    expect(loaded.state.travel).toEqual({ stage: "docked", portId: PORTS.a });
  });
});

describe("departure gate on a voyage (§2.3): asked once per voyage", () => {
  it("'Leave anyway' at the start covers every waypoint and is forgotten when the voyage ends", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    setCourseTo(kernel, world, PORTS.d);
    expectGateAsked(kernel, world);
    resolveGate(kernel, world, "right");

    const toC = advanceUntil(kernel, world, dockedAt(PORTS.c));
    expect(toC.haltedOnDecision).toBe(false);
    expect(world.state.travel).toMatchObject({
      stage: "docked",
      portId: PORTS.c,
      voyageDestinationId: PORTS.d,
      departureRiskAccepted: true,
      acceptedImpairmentKey: `${theEngine(world).id}:fault`,
    });

    // Through the waypoint without a second card, still faulty.
    const toD = advanceUntil(kernel, world, dockedAt(PORTS.d));
    expect(toD.haltedOnDecision).toBe(false);
    expect(world.state.decisions.queue).toEqual([]);
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.d });

    // The voyage is over: the next planned departure asks again.
    setCourseTo(kernel, world, PORTS.c);
    expectGateAsked(kernel, world);
  });

  it("asks again at a waypoint when the impaired set has changed since 'leave anyway'", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    setCourseTo(kernel, world, PORTS.d);
    expectGateAsked(kernel, world);
    resolveGate(kernel, world, "right");
    advanceUntil(kernel, world, dockedAt(PORTS.c));

    // The same fault now derates output: a different impairment, so the engineer speaks again.
    theEngine(world).output = 0.5;
    expectGateAsked(kernel, world, 20);
    expect(pendingGate(world)?.prompt.params.reason).toBe("faultDerated");
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: PORTS.c });
  });

  it("a repair on the way clears the answer, so a new fault later asks again; a healthy ship never does", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    setCourseTo(kernel, world, PORTS.d);
    expectGateAsked(kernel, world);
    resolveGate(kernel, world, "right");
    advanceUntil(kernel, world, dockedAt(PORTS.c));

    theEngine(world).faults = [];
    kernel.advance(world, 1);
    expect(world.state.travel).toMatchObject({ stage: "preparingDeparture", toPortId: PORTS.d });
    expect(world.state.travel.departureRiskAccepted).toBeUndefined();
    expect(world.state.decisions.queue).toEqual([]);

    addFault(world, "wornBearing");
    expectGateAsked(kernel, world, 20);
  });

  it("'Hold for repairs' at a waypoint waits docked with the voyage kept, then continues", () => {
    const { world, kernel } = freightTestWorld();
    world.state.travel = { stage: "docked", portId: PORTS.c, voyageDestinationId: PORTS.d };
    addFault(world, "wornBearing");
    expectGateAsked(kernel, world, 20);
    resolveGate(kernel, world, "left");
    kernel.advance(world, 100);
    expect(world.state.travel).toEqual({
      stage: "docked",
      portId: PORTS.c,
      plannedDestinationId: PORTS.d,
      voyageDestinationId: PORTS.d,
      holdForRepairs: true,
    });
    theEngine(world).faults = [];
    const released = kernel.advance(world, 100);
    expect(released.events.some((e) => e.type === "departureHoldLifted")).toBe(true);
    expect(world.state.travel).toMatchObject({
      stage: "transit",
      toPortId: PORTS.d,
      voyageDestinationId: PORTS.d,
    });
  });

  it("honours a pre-voyage save's 'leave anyway' that carries no impairment key", () => {
    const { world, kernel } = freightTestWorld();
    addFault(world, "wornBearing");
    world.state.travel = {
      stage: "docked",
      portId: PORTS.a,
      plannedDestinationId: PORTS.b,
      departureRiskAccepted: true,
    };
    const result = kernel.advance(world, 80);
    expect(result.halt).toEqual({ kind: "completed" });
    expect(world.state.decisions.queue).toEqual([]);
    expect(world.state.travel.stage).toBe("transit");
  });
});
