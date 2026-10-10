/**
 * §impairments-out-of-reach, §repairs-out-of-reach: whether an impairment's repair is in reach. A
 * machine with no fault of its own that another machine's impairment causes (an engine starved of
 * power by a derated generator, an engine overheating with its bus's coolant pump down) is in reach
 * only if that cause is, and the reason given is the cause's fault. With no cause to point at, the
 * plain answer stands (in reach). Judged on hand-set state over the W5 deck (one bus: generator,
 * battery, pump, engine).
 */
import { describe, expect, it } from "vitest";
import { tinyConfig } from "../../core/fixtures/tiny-content";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { ContentBundle, MachineDef } from "../../core/types/content";
import type { ItemDefId, MachineDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { W5, w5Content, w5EffectiveConfig } from "../equipment/fixtures/w5-content";
import { registerEquipmentSystems } from "../equipment/register";
import { impairmentOutOfReach } from "./departure-gate";

const COIL = "item.w5.coil" as ItemDefId;

/** `def` with one more fault, whose one repair step consumes a `COIL`. */
function withCoilFault(
  def: MachineDef,
  key: string,
  effect: MachineDef["faults"][number]["effect"],
) {
  return {
    ...def,
    faults: [
      ...def.faults,
      {
        key,
        name: key,
        weight: 1,
        effect,
        symptom: { key: `${key}Symptom`, channel: "sensor" as const },
        repair: {
          steps: [
            {
              key: "fit",
              action: "repair",
              workSeconds: 5,
              tools: [],
              consumes: [{ itemDefId: COIL, count: 1 }],
              at: "repair" as const,
            },
          ],
        },
      },
    ],
  };
}

function reachContent(coilsForSale: number): ContentBundle {
  const base = w5Content(tinyConfig());
  const machine = (id: MachineDefId): MachineDef => {
    const def = base.machines[id];
    if (def === undefined) throw new Error(`w5 fixture lost ${id}`);
    return def;
  };
  const port = base.ports[W5.port];
  const scenario = base.scenarios[W5.scenario];
  if (port === undefined || scenario === undefined) throw new Error("w5 fixture changed");
  return {
    ...base,
    machines: {
      ...base.machines,
      [W5.generator]: withCoilFault(machine(W5.generator), "coilBurnout", {
        kind: "derate",
        outputFactor: 0.35,
      }),
      [W5.pump]: withCoilFault(machine(W5.pump), "seized", { kind: "inoperable" }),
    },
    items: {
      ...base.items,
      [COIL]: {
        id: COIL,
        name: "Stator coil",
        stacking: "stackable",
        maxStack: 5,
        tags: ["spare"],
        toolKinds: [],
        mass: 1,
      },
    },
    ports: {
      ...base.ports,
      [W5.port]: { ...port, market: [{ itemDefId: COIL, count: coilsForSale, price: 10 }] },
    },
    scenarios: { ...base.scenarios, [W5.scenario]: { ...scenario, startingMoney: 100 } },
    hash: "reach-test-v1",
  };
}

function reachWorld(coilsForSale = 0): World {
  const registry = createRegistry();
  registerEquipmentSystems(registry);
  const kernel = createKernel(registry);
  const config = tinyConfig();
  return kernel.createWorld(W5.scenario, 7, reachContent(coilsForSale), w5EffectiveConfig(config));
}

function machineOf(world: World, defId: MachineDefId) {
  const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`no ${defId}`);
  return machine;
}

function fault(world: World, faultKey: string) {
  return {
    faultKey,
    sinceTick: world.state.tick,
    diagnosed: true,
    repairStepIndex: 0,
    repairStepProgress: 0,
  };
}

/** The generator's coil burnt out (output 0.35), the engine on a sixth of its draw, no fault. */
function starveEngine(world: World): void {
  const generator = machineOf(world, W5.generator);
  generator.faults = [fault(world, "coilBurnout")];
  generator.output = 0.35;
  const engine = machineOf(world, W5.engine);
  engine.faults = [];
  engine.powerAllocatedKw = 1;
  engine.output = 1 / 6;
}

function ctxOf(world: World) {
  return { state: world.state, content: world.content, config: world.config.values };
}

describe("an impairment caused by another machine's is in reach only if its cause is", () => {
  it("an engine starved by a generator whose part is not to be had is out of reach, for the generator's fault", () => {
    const world = reachWorld(0);
    starveEngine(world);
    const generator = machineOf(world, W5.generator);
    const engine = machineOf(world, W5.engine);
    expect(impairmentOutOfReach(ctxOf(world), engine.id, W5.port)).toEqual({
      machineId: generator.id,
      faultKey: "coilBurnout",
      itemDefId: COIL,
      count: 1,
      need: "part",
    });
    // Under way there is no market either.
    expect(impairmentOutOfReach(ctxOf(world), engine.id, undefined)).toMatchObject({
      machineId: generator.id,
    });
  });

  it("is in reach when the port sells the generator's part", () => {
    const world = reachWorld(2);
    starveEngine(world);
    expect(impairmentOutOfReach(ctxOf(world), machineOf(world, W5.engine).id, W5.port)).toBe(
      undefined,
    );
  });

  it("is in reach while the generator's fault is undiagnosed (the crew can still look)", () => {
    const world = reachWorld(0);
    starveEngine(world);
    const generator = machineOf(world, W5.generator);
    generator.faults = [{ ...fault(world, "coilBurnout"), diagnosed: false }];
    expect(impairmentOutOfReach(ctxOf(world), machineOf(world, W5.engine).id, W5.port)).toBe(
      undefined,
    );
  });

  it("keeps the plain answer with no cause to point at: a starved engine on a healthy bus", () => {
    const world = reachWorld(0);
    const engine = machineOf(world, W5.engine);
    engine.powerAllocatedKw = 1;
    engine.output = 1 / 6;
    expect(impairmentOutOfReach(ctxOf(world), engine.id, W5.port)).toBe(undefined);
  });

  it("an engine overheating with the bus's only coolant pump seized is out of reach for the pump's fault", () => {
    const world = reachWorld(0);
    const pump = machineOf(world, W5.pump);
    pump.faults = [fault(world, "seized")];
    pump.actualMode = "off";
    pump.output = 0;
    const engine = machineOf(world, W5.engine);
    engine.temperature = 1;
    engine.output = 0;
    expect(impairmentOutOfReach(ctxOf(world), engine.id, W5.port)).toMatchObject({
      machineId: pump.id,
      faultKey: "seized",
      itemDefId: COIL,
    });
    pump.actualMode = "on";
    expect(impairmentOutOfReach(ctxOf(world), engine.id, W5.port)).toBe(undefined);
  });
});
