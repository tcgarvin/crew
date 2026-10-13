import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { checkInvariants } from "../../core/invariants";
import { getRenderFrame, tickerLine } from "../../core/render";
import type { SimEvent } from "../../core/types/events";
import type { Machine } from "../../core/types/ship";
import { w5TestWorld } from "./fixtures/test-world";
import { W5 } from "./fixtures/w5-content";

function byDef(world: ReturnType<typeof w5TestWorld>["world"], defId: string): Machine {
  const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`no machine for ${defId}`);
  return machine;
}

describe("heat, derating and hysteresis", () => {
  it("derates then shuts the engine off without its coolant pump, and recovers once it's back", () => {
    const { kernel, world } = w5TestWorld();
    const pump = byDef(world, W5.pump);
    pump.desiredMode = "off";

    kernel.advance(world, 800); // 40s without cooling: past derateAbove but not yet failed
    const derating = byDef(world, W5.engine);
    expect(derating.temperature).toBeGreaterThan(0.5);
    expect(derating.output).toBeLessThan(1);

    kernel.advance(world, 800); // another 40s: now over the failure point
    const shutdown = byDef(world, W5.engine);
    expect(shutdown.temperature).toBeGreaterThanOrEqual(1);
    expect(shutdown.actualMode).toBe("off");

    pump.desiredMode = "on";
    kernel.advance(world, 2000); // 100s with cooling restored: net rate is negative
    const recovered = byDef(world, W5.engine);
    expect(recovered.temperature).toBeLessThan(1);
    expect(recovered.actualMode).toBe("on");

    expect(checkInvariants(world.state)).toEqual([]);
  });

  it("cools at the reduced rate in the same tick the pump overheats and stops", () => {
    // The coolant index is built once per equipment pass; it must read the pump's live mode, so
    // a pump ticked (and stopped) earlier in the pass counts as off for the engine after it.
    const { kernel, world } = w5TestWorld();
    kernel.advance(world, 20);
    const pump = byDef(world, W5.pump);
    const engine = byDef(world, W5.engine);
    const order = Object.keys(world.state.machines);
    expect(order.indexOf(pump.id)).toBeLessThan(order.indexOf(engine.id));
    expect(pump.actualMode).toBe("on");
    expect(engine.actualMode).toBe("on");

    pump.temperature = 1; // at the failure point: equipment stops it during its own tick
    engine.temperature = 0.3;
    kernel.advance(world, 1);

    expect(byDef(world, W5.pump).actualMode).toBe("off");
    // With the pump counted as running the engine would cool (rise 0.02/s < cool 0.03/s); at the
    // reduced coolant fraction it warms instead.
    expect(byDef(world, W5.engine).temperature).toBeGreaterThan(0.3);
  });
});

describe("hazard and fault draws", () => {
  it("produces a fault within a bounded number of ticks at a high hazard rate", () => {
    const { kernel, world } = w5TestWorld({
      overrides: { engineFailure: { baseHazardPerSecond: 100, heatFactor: 1, wearPerSecond: 0 } },
    });
    kernel.advance(world, 500);
    const engine = byDef(world, W5.engine);
    expect(engine.faults.length).toBeGreaterThan(0);
    expect(engine.faults[0]?.faultKey).toBe("wornBearing");

    const symptom = Object.values(world.state.work.problems).find(
      (p) => p.kind === "machineSymptom" && p.payload.machineId === engine.id,
    );
    expect(symptom).toBeDefined();
    expect(symptom?.visibility).toBe("discovered");
    expect(checkInvariants(world.state)).toEqual([]);
  });

  it("produces no fault at a zero hazard rate", () => {
    const { kernel, world } = w5TestWorld({
      overrides: { engineFailure: { baseHazardPerSecond: 0, heatFactor: 1, wearPerSecond: 0 } },
    });
    kernel.advance(world, 500);
    expect(byDef(world, W5.engine).faults).toEqual([]);
  });
});

describe("scheduleFault", () => {
  it("fires inside its window", () => {
    const { kernel, world } = w5TestWorld();
    const engine = byDef(world, W5.engine);
    const startTick = world.state.tick;
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scheduleFault",
        payload: { machineId: engine.id, faultKey: "wornBearing", windowTicks: [5, 10] },
      }),
    );
    expect(result.status).toBe("accepted");
    kernel.advance(world, 1); // apply the command
    expect(byDef(world, W5.engine).scheduledFaults).toHaveLength(1);
    const fireAtTick = byDef(world, W5.engine).scheduledFaults[0]?.fireAtTick as number;
    expect(fireAtTick).toBeGreaterThanOrEqual(startTick + 1 + 5);
    expect(fireAtTick).toBeLessThanOrEqual(startTick + 1 + 10);

    kernel.advance(world, 15);
    expect(byDef(world, W5.engine).faults.map((f) => f.faultKey)).toContain("wornBearing");
    expect(byDef(world, W5.engine).scheduledFaults).toEqual([]);
  });

  it("spends the narrator's fault budget, and past zero still schedules: the budget is advice (§narrator-lever-budgets)", () => {
    const { kernel, world } = w5TestWorld();
    const engine = byDef(world, W5.engine);
    const schedule = (faultKey: string) =>
      kernel.enqueueCommand(
        world,
        cmd({
          source: "scenario",
          kind: "scheduleFault",
          payload: { machineId: engine.id, faultKey, windowTicks: [50, 60] },
        }),
      );
    world.state.narrator.budget.faultsRemaining = 0;
    expect(schedule("wornBearing").status).toBe("accepted");
    kernel.advance(world, 1);
    expect(world.state.narrator.budget.faultsRemaining).toBe(-1);
  });

  it("is rejected for an unknown fault key", () => {
    const { kernel, world } = w5TestWorld();
    const engine = byDef(world, W5.engine);
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scheduleFault",
        payload: { machineId: engine.id, faultKey: "notAFault", windowTicks: [1, 2] },
      }),
    );
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.rejection.code).toBe("invalidPayload");
  });

  it("is rejected from an unauthorized source", () => {
    const { kernel, world } = w5TestWorld();
    const engine = byDef(world, W5.engine);
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "player",
        kind: "scheduleFault",
        payload: { machineId: engine.id, faultKey: "wornBearing", windowTicks: [1, 2] },
      }),
    );
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.rejection.code).toBe("unauthorized");
  });
});

describe("maintenance", () => {
  it("raises maintenanceDue once condition falls below the threshold, and resolves it once restored", () => {
    const { kernel, world } = w5TestWorld({
      overrides: { engineFailure: { baseHazardPerSecond: 0, heatFactor: 1, wearPerSecond: 0.05 } },
    });
    kernel.advance(world, 300);
    const engine = byDef(world, W5.engine);
    expect(engine.condition).toBeLessThan(0.3);
    const due = Object.values(world.state.work.problems).find(
      (p) =>
        p.kind === "maintenanceDue" && p.payload.machineId === engine.id && p.status === "open",
    );
    expect(due).toBeDefined();

    engine.condition = 1;
    kernel.advance(world, 1);
    const problemId = due?.id;
    expect(problemId).toBeDefined();
    expect(problemId !== undefined ? world.state.work.problems[problemId]?.status : undefined).toBe(
      "resolved",
    );
  });

  it("raises the open problem to essential once condition falls below the essential threshold", () => {
    const { kernel, world } = w5TestWorld({
      overrides: { engineFailure: { baseHazardPerSecond: 0, heatFactor: 1, wearPerSecond: 0 } },
    });
    const { maintenanceConditionBelow, maintenanceEssentialBelow } = world.config.values.equipment;
    const engine = byDef(world, W5.engine);
    const due = () =>
      Object.values(world.state.work.problems).find(
        (p) =>
          p.kind === "maintenanceDue" && p.payload.machineId === engine.id && p.status === "open",
      );
    engine.condition = (maintenanceConditionBelow + maintenanceEssentialBelow) / 2;
    kernel.advance(world, 1);
    expect(due()?.baseUrgency).toBe("routineObligation");
    const id = due()?.id;
    engine.condition = maintenanceEssentialBelow / 2;
    kernel.advance(world, 1);
    expect(due()?.id).toBe(id);
    expect(due()?.baseUrgency).toBe("essentialOperation");
  });
});

describe("integrity (§integrity)", () => {
  it("derates output linearly between the derate and inoperable thresholds", () => {
    const { kernel, world } = w5TestWorld();
    const { integrityDerateBelow, integrityInoperableBelow } = world.config.values.equipment;
    const engine = byDef(world, W5.engine);
    kernel.advance(world, 1);
    expect(engine.output).toBe(1);

    engine.integrity = integrityDerateBelow; // at the threshold: untouched
    kernel.advance(world, 1);
    expect(engine.output).toBe(1);

    engine.integrity = (integrityDerateBelow + integrityInoperableBelow) / 2; // halfway down
    const derated = kernel.advance(world, 1);
    expect(engine.output).toBeCloseTo(0.5, 5);
    expect(engine.actualMode).toBe("on");
    expect(derated.events.find((e) => e.type === "machineDerated")).toMatchObject({
      payload: { machineId: engine.id, cause: "integrity" },
    });
    expect(checkInvariants(world.state)).toEqual([]);
  });

  it("blocks the machine below the inoperable threshold and renders it as failed", () => {
    const { kernel, world } = w5TestWorld();
    const engine = byDef(world, W5.engine);
    engine.integrity = world.config.values.equipment.integrityInoperableBelow - 0.01;
    kernel.advance(world, 5);
    expect(engine.actualMode).toBe("off");
    expect(engine.output).toBe(0);
    const rendered = getRenderFrame(world).machines.find((m) => m.id === engine.id);
    expect(rendered?.state).toBe("failed");

    // Still blocked next tick: nothing but a repair restores integrity.
    kernel.advance(world, 20);
    expect(engine.actualMode).toBe("off");
    expect(checkInvariants(world.state)).toEqual([]);
  });
});

describe("derates in a burst (§output-and-blocking)", () => {
  /** Two more life-support units on the same placement: three machines of one def. */
  function threeOfADef() {
    const { kernel, world } = w5TestWorld();
    const original = byDef(world, W5.lifeSupport);
    const units = [original];
    for (const n of [2, 3]) {
      const id = `${original.id}-${n}` as Machine["id"];
      world.state.machines[id] = { ...structuredClone(original), id };
      units.push(world.state.machines[id] as Machine);
    }
    kernel.advance(world, 1);
    return { kernel, world, units };
  }

  it("says one machinesDerated for the machines of one def that fall together", () => {
    const { kernel, world, units } = threeOfADef();
    const { integrityDerateBelow, integrityInoperableBelow } = world.config.values.equipment;
    for (const unit of units)
      unit.integrity = (integrityDerateBelow + integrityInoperableBelow) / 2;
    const result = kernel.advance(world, 1);
    const ids = new Set<string>(units.map((u) => u.id));
    expect(
      result.events.filter((e) => e.type === "machineDerated" && ids.has(e.payload.machineId)),
    ).toEqual([]);
    const burst = result.events.filter((e) => e.type === "machinesDerated");
    expect(burst).toHaveLength(1);
    expect(burst[0]?.payload).toMatchObject({
      groups: [{ defId: W5.lifeSupport, count: 3 }],
      cause: "integrity",
    });
    expect(burst[0]?.subjectIds).toEqual(units.map((u) => u.id));
    expect(tickerLine(burst[0] as SimEvent, world.state, world.content)).toMatch(
      /^3 .+s at 50% \(integrity\)$/,
    );
  });

  it("says machineDerated, as alone, for one machine of the def", () => {
    const { kernel, world, units } = threeOfADef();
    const [first] = units;
    if (first === undefined) throw new Error("no unit");
    first.integrity = 0.3;
    const result = kernel.advance(world, 1);
    expect(result.events.filter((e) => e.type === "machinesDerated")).toEqual([]);
    expect(result.events.filter((e) => e.type === "machineDerated")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ machineId: first.id }) }),
    ]);
  });

  it("names the defs of a burst across machines in one line, the biggest group first", () => {
    const { kernel, world, units } = threeOfADef();
    const { integrityDerateBelow, integrityInoperableBelow } = world.config.values.equipment;
    const halfway = (integrityDerateBelow + integrityInoperableBelow) / 2;
    for (const unit of [...units, byDef(world, W5.engine)]) unit.integrity = halfway;
    const result = kernel.advance(world, 1);
    const burst = result.events.filter((e) => e.type === "machinesDerated");
    expect(burst.map((e) => e.payload.groups)).toEqual([
      [
        expect.objectContaining({ defId: W5.lifeSupport, count: 3 }),
        expect.objectContaining({ defId: W5.engine, count: 1 }),
      ],
    ]);
    expect(tickerLine(burst[0] as SimEvent, world.state, world.content)).toMatch(
      /^Worn down: 3 .+s and [^0-9]+$/,
    );
  });

  it("keeps a power derate off the ticker within powerLineQuietSeconds of the last power line", () => {
    const quietWorld = () => {
      const fixture = threeOfADef();
      for (const id of [W5.generator, W5.battery]) byDef(fixture.world, id).desiredMode = "off";
      return fixture;
    };
    const loud = quietWorld();
    const first = loud.kernel.advance(loud.world, 1).events;
    const lines = first.filter((e) => e.type === "machinesDerated" || e.type === "machineDerated");
    expect(lines.length).toBeGreaterThan(0);
    for (const e of lines) expect(e.significance).toBe("notable");
    expect(loud.world.state.power.lineTick).toBe(loud.world.state.tick);

    const quiet = quietWorld();
    quiet.world.state.power.lineTick = quiet.world.state.tick;
    const events = quiet.kernel.advance(quiet.world, 1).events;
    const muted = events.filter((e) => e.type === "machinesDerated" || e.type === "machineDerated");
    expect(muted.length).toBeGreaterThan(0);
    for (const e of muted) expect(e.significance).toBe("trace");
  });
});
