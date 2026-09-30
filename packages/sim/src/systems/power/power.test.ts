import { describe, expect, it } from "vitest";
import type { Machine } from "../../core/types/ship";
import { w5TestWorld } from "../equipment/fixtures/test-world";
import { W5 } from "../equipment/fixtures/w5-content";

function byDef(world: ReturnType<typeof w5TestWorld>["world"], defId: string): Machine {
  const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`no machine for ${defId}`);
  return machine;
}

describe("power allocation", () => {
  it("serves higher-priority tiers first and derates/turns off what a shortfall can't cover", () => {
    const { kernel, world } = w5TestWorld({ overrides: { generatorSupplyKw: 4 } });
    const battery = byDef(world, W5.battery);
    // Drain the battery so this test isolates tier prioritisation from battery top-up.
    battery.roleState = { role: "battery", storedKj: 0 };

    kernel.advance(world, 1);

    const life = byDef(world, W5.lifeSupport);
    const pump = byDef(world, W5.pump);
    const engine = byDef(world, W5.engine);
    // lifeSupport (2kW) then criticalCooling (1kW) are fully served from 4kW; propulsion (6kW)
    // gets whatever is left (1kW) — its def derates on partial power, so it stays "on" but at a
    // fraction of its draw.
    expect(life.actualMode).toBe("on");
    expect(life.powerAllocatedKw).toBeCloseTo(2, 6);
    expect(pump.actualMode).toBe("on");
    expect(pump.powerAllocatedKw).toBeCloseTo(1, 6);
    expect(engine.actualMode).toBe("on");
    expect(engine.powerAllocatedKw).toBeCloseTo(1, 6);

    const domain = world.state.power.domains.main;
    expect(domain?.demandKw).toBeCloseTo(9, 6);
    expect(domain?.supplyKw).toBeCloseTo(4, 6);
  });

  it("discharges the battery to cover a shortfall", () => {
    const { kernel, world } = w5TestWorld({ overrides: { generatorSupplyKw: 4 } });
    const battery = byDef(world, W5.battery);
    expect(battery.roleState).toMatchObject({ role: "battery", storedKj: 20 }); // spawns full

    kernel.advance(world, 1);
    // Full battery covers the 5kW shortfall this tick (maxDischargeKw 5).
    const engine = byDef(world, W5.engine);
    expect(engine.actualMode).toBe("on");
    expect(engine.powerAllocatedKw).toBeCloseTo(6, 6);
    expect(world.state.power.domains.main?.batteryFlowKw).toBeLessThan(0);
    expect((battery.roleState as { storedKj: number }).storedKj).toBeLessThan(20);
  });

  it("charges the battery from surplus when demand is fully served", () => {
    const { kernel, world } = w5TestWorld();
    const battery = byDef(world, W5.battery);
    battery.roleState = { role: "battery", storedKj: 5 };

    kernel.advance(world, 1);
    // supplyKw 10 - demand 9 = 1kW surplus, banked into the battery.
    expect(world.state.power.domains.main?.batteryFlowKw).toBeGreaterThan(0);
    expect((battery.roleState as { storedKj: number }).storedKj).toBeGreaterThan(5);
  });

  it("clears dirty.power after running", () => {
    const { kernel, world } = w5TestWorld();
    world.caches.dirty.power = true;
    kernel.advance(world, 1);
    expect(world.caches.dirty.power).toBe(false);
  });
});
