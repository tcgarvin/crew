/**
 * D80: a ship whose engine is down in transit with no repair possible aboard limps on at
 * `travel.limpSpeedFraction` of nominal speed instead of drifting for good, and says so once
 * (`shipLimping`). While a repair aboard can still bring the engine back (the part is aboard, or
 * the fault is not diagnosed yet) it drifts as before, and a repaired engine ends the limp.
 * Only travel and commerce run here, so the engine's mode, output and faults are set by hand.
 */
import { describe, expect, it } from "vitest";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import { describeEvent } from "../../core/render";
import type { ContentBundle, MachineDef } from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { CommandId, ItemDefId, ItemId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { registerCommerce } from "../commerce";
import {
  FIX,
  PORTS,
  advanceToStage,
  fixtureConfig,
  fixtureContent,
  fixtureEffectiveConfig,
} from "./fixtures";
import { registerTravel } from "./index";

const SPARES = "item.freight.spares" as ItemDefId;
const LIMP = 0.2;

/** The fixture engine with an inoperable fault whose repair consumes one `SPARES`. */
function limpContent(): ContentBundle {
  const config = fixtureConfig({ limpSpeedFraction: LIMP });
  const base = fixtureContent(config);
  const engine = base.machines[FIX.engine];
  if (engine === undefined) throw new Error("freight fixture lost its engine");
  const seizable: MachineDef = {
    ...engine,
    faults: [
      ...engine.faults,
      {
        key: "seizedController",
        name: "Seized controller",
        weight: 1,
        effect: { kind: "inoperable" },
        symptom: { key: "stall", channel: "sensor" },
        repair: {
          steps: [
            {
              key: "fit_controller",
              action: "installComponent",
              workSeconds: 5,
              tools: [],
              consumes: [{ itemDefId: SPARES, count: 1 }],
              at: "repair",
            },
          ],
        },
      },
    ],
  };
  return {
    ...base,
    machines: { ...base.machines, [FIX.engine]: seizable },
    items: {
      ...base.items,
      [SPARES]: {
        id: SPARES,
        name: "Spare Parts",
        stacking: "stackable",
        maxStack: 20,
        tags: ["spare"],
        toolKinds: [],
        mass: 0.5,
      },
    },
    hash: "limp-test-v1",
  };
}

function limpWorld() {
  const registry = createRegistry();
  registerTravel(registry);
  registerCommerce(registry);
  const kernel = createKernel(registry);
  const config = fixtureConfig({ limpSpeedFraction: LIMP });
  const world = kernel.createWorld(FIX.scenario, 42, limpContent(), fixtureEffectiveConfig(config));
  kernel.enqueueCommand(world, {
    id: "cmd:limp:course" as CommandId,
    source: "player",
    kind: "setCourse",
    payload: { destinationPortId: PORTS.c },
  });
  advanceToStage(kernel, world, "transit");
  return { kernel, world };
}

function theEngine(world: World) {
  const engine = Object.values(world.state.machines).find((m) => m.defId === FIX.engine);
  if (engine === undefined) throw new Error("engine missing");
  return engine;
}

/** The engine seizes: down, with the fault aboard (diagnosed or not). */
function seize(world: World, diagnosed: boolean): void {
  const engine = theEngine(world);
  engine.faults.push({
    faultKey: "seizedController",
    sinceTick: world.state.tick,
    diagnosed,
    repairStepIndex: 0,
    repairStepProgress: 0,
  });
  engine.actualMode = "off";
  engine.output = 0;
}

function transit(world: World) {
  const travel = world.state.travel;
  if (travel.stage !== "transit") throw new Error(`not in transit: ${travel.stage}`);
  return travel;
}

function advance(kernel: ReturnType<typeof createKernel>, world: World, ticks: number) {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...kernel.advance(world, 1).events);
  return events;
}

describe("limping home (D80)", () => {
  it("limps at the configured fraction once the repair is out of reach aboard, and says so once", () => {
    const { kernel, world } = limpWorld();
    seize(world, true);
    const before = transit(world).routeProgress;
    const events = advance(kernel, world, 20);
    const travel = transit(world);
    expect(travel.drifting).toBe(true);
    expect(travel.limping).toBe(true);
    // 1 s at 0.2 × nominal 5.
    expect(travel.routeProgress - before).toBeCloseTo(1, 5);
    const limped = events.filter((e) => e.type === "shipLimping");
    expect(limped).toHaveLength(1);
    expect(limped[0]).toMatchObject({
      significance: "narrative",
      payload: {
        machineId: theEngine(world).id,
        faultKey: "seizedController",
        itemDefId: SPARES,
        need: "part",
        speedFraction: LIMP,
      },
    });
    const line =
      limped[0] === undefined ? null : describeEvent(limped[0], world.state, world.content);
    expect(line).toBe(
      "Not enough spare parts aboard to fix the main engine's seized controller: limping on at 20% speed",
    );
  });

  it("drifts while a repair aboard can still bring the engine back", () => {
    for (const setup of ["undiagnosed", "partAboard"] as const) {
      const { kernel, world } = limpWorld();
      seize(world, setup === "partAboard");
      if (setup === "partAboard") {
        const id = "i900" as ItemId;
        world.state.items[id] = {
          id,
          defId: SPARES,
          stacking: "stack",
          count: 1,
          reserved: 0,
          location: { kind: "onDeck", deckId: FIX.deck, x: 2.5, y: 1.5 },
        };
      }
      const before = transit(world).routeProgress;
      const events = advance(kernel, world, 20);
      expect(transit(world).routeProgress).toBe(before);
      expect(transit(world).limping).toBeUndefined();
      expect(events.some((e) => e.type === "shipLimping")).toBe(false);
    }
  });

  it("ends the limp when the engine is repaired, and arrives", () => {
    const { kernel, world } = limpWorld();
    seize(world, true);
    advance(kernel, world, 20);
    expect(transit(world).limping).toBe(true);
    const engine = theEngine(world);
    engine.faults = [];
    engine.actualMode = "on";
    engine.output = 1;
    const events = advance(kernel, world, 1);
    expect(transit(world).limping).toBeUndefined();
    expect(transit(world).drifting).toBe(false);
    expect(events.some((e) => e.type === "driftingChanged")).toBe(true);
    advanceToStage(kernel, world, "approaching");
  });
});
