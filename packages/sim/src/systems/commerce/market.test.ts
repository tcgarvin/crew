/**
 * D47: the parts market, through the real kernel. A diagnosed engine fault whose repair step
 * consumes a part the ship does not carry raises `partsNeeded`; while docked at a port whose
 * market sells it and the ship can pay, a crew member walks to the ramp, buys it (money down,
 * market down, parts on the deck, `partsBought` in the ticker), and the repair then completes.
 * Without stock or money the problem stays open and nothing is bought. The narrator's
 * `stockMarket` makes a part available or withdraws it, and a departure held for repairs waits
 * docked until the part is bought and fitted.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { createKernel } from "../../core/kernel";
import { effectiveMarket } from "../../core/markets";
import { createRegistry } from "../../core/registry";
import type { Command } from "../../core/types/commands";
import type { ContentBundle, MachineDef } from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { CommandId, HookId, ItemDefId, MachineId, PortDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { registerPlannerDefaults } from "../../planner/index";
import { registerEquipmentSystems } from "../equipment/register";
import { registerNeeds } from "../needs/index";
import { registerSpatial } from "../spatial/index";
import { spatialViolations } from "../spatial/invariants";
import { registerTravel } from "../travel/index";
import {
  ALL_DERIVATIONS,
  CREW,
  JON,
  MARA,
  addEngineFault,
  crewConfig,
  crewContent,
  place,
} from "../work/fixtures/crew-deck";
import { registerWork } from "../work/index";
import { workViolations } from "../work/invariants";
import { registerCommerce } from "./index";

const PARTS = "item.test.parts" as ItemDefId;
const PORT = TINY.port;
const PRICE = 120;

interface MarketWorldOptions {
  readonly stock?: number;
  readonly money?: number;
  readonly travel?: boolean;
}

/** Crew deck, engine misfire now consumes one `PARTS`, the dock sells `stock` of them. */
function marketContent(options: MarketWorldOptions): ContentBundle {
  const base = crewContent(crewConfig());
  const engine = base.machines[CREW.engine];
  const port = base.ports[PORT];
  const scenario = base.scenarios[CREW.scenario2];
  if (engine === undefined || port === undefined || scenario === undefined) {
    throw new Error("crew-deck fixture changed");
  }
  const misfire = engine.faults.find((f) => f.key === "misfire");
  if (misfire === undefined) throw new Error("crew-deck engine lost its misfire");
  const hungryEngine: MachineDef = {
    ...engine,
    faults: [
      {
        ...misfire,
        repair: {
          steps: misfire.repair.steps.map((step) => ({
            ...step,
            consumes: [{ itemDefId: PARTS, count: 1 }],
          })),
        },
      },
    ],
  };
  return {
    ...base,
    machines: { ...base.machines, [CREW.engine]: hungryEngine },
    items: {
      ...base.items,
      [PARTS]: {
        id: PARTS,
        name: "Engine Parts",
        stacking: "stackable",
        maxStack: 10,
        tags: ["spare"],
        toolKinds: [],
        mass: 0.5,
      },
    },
    ports: {
      ...base.ports,
      [PORT]: {
        ...port,
        market: [{ itemDefId: PARTS, count: options.stock ?? 2, price: PRICE }],
      },
    },
    scenarios: {
      ...base.scenarios,
      [CREW.scenario2]: { ...scenario, startingMoney: options.money ?? 500 },
    },
    hash: "market-test-v1",
  };
}

function marketWorld(options: MarketWorldOptions = {}): TestWorld {
  const config = crewConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerEquipmentSystems(registry);
  if (options.travel === true) registerTravel(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerWork(registry, { derivations: ALL_DERIVATIONS });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    CREW.scenario2,
    11,
    marketContent(options),
    tinyEffectiveConfig(config),
  );
  place(world, MARA, { x: 3, y: 6 });
  place(world, JON, { x: 9, y: 3 });
  return { registry, kernel, world };
}

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:market-test:${counter}` as CommandId };
}

/** Step tick by tick, acknowledging hooks and checking invariants; stops on `until` or a card. */
function run(tw: TestWorld, ticks: number, until?: (world: World) => boolean): SimEvent[] {
  const { kernel, world } = tw;
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...workViolations(world),
    ];
    if (violations.length > 0)
      throw new Error(`tick ${world.state.tick}: ${violations.join("; ")}`);
    if (result.halt.kind === "hook") {
      const hookId = world.state.narrator.pendingHook?.id as HookId | undefined;
      if (hookId === undefined) throw new Error("hook halt without a pending hook");
      kernel.enqueueCommand(
        world,
        cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
      );
    } else if (result.halt.kind === "decision") {
      return events;
    }
    if (until?.(world)) break;
  }
  return events;
}

function openPartsNeeded(world: World) {
  return Object.values(world.state.work.problems).filter(
    (p) => p.kind === "partsNeeded" && p.status === "open",
  );
}

function partsAboard(world: World): number {
  return Object.values(world.state.items)
    .filter((i) => i.defId === PARTS && i.location.kind !== "inExternalStore")
    .reduce((n, i) => n + (i.stacking === "stack" ? i.count : 1), 0);
}

function engineFaults(world: World, machineId: MachineId) {
  return world.state.machines[machineId]?.faults ?? [];
}

const TWO_MINUTES = 20 * 120;

describe("parts market (D47): a repair that needs a part the ship lacks", () => {
  it("raises partsNeeded for the shortfall, once per machine and item, and nothing else buys", () => {
    const tw = marketWorld({ stock: 0 });
    const { problemId } = addEngineFault(tw.world);
    run(tw, 20);
    const open = openPartsNeeded(tw.world);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "partsNeeded",
      owner: "equipment",
      visibility: "public",
      payload: { itemDefId: PARTS, count: 1 },
    });
    expect(tw.world.state.work.problems[problemId]?.status).toBe("open");
    const buyTasks = Object.values(tw.world.state.work.tasks).filter((t) => t.type === "buyParts");
    expect(buyTasks).toEqual([]);
  });

  it("buys it at the dock: money down, market down, parts aboard, ticker line, repair done", () => {
    const tw = marketWorld({ stock: 2, money: 500 });
    const { world } = tw;
    const { machineId, problemId } = addEngineFault(world);
    const events = run(
      tw,
      TWO_MINUTES,
      (w) => w.state.work.problems[problemId]?.status === "resolved",
    );

    const bought = events.find((e) => e.type === "partsBought");
    expect(bought).toMatchObject({
      significance: "narrative",
      payload: { portId: PORT, itemDefId: PARTS, count: 1, cost: PRICE },
    });
    const partsProblem = Object.values(world.state.work.problems).find(
      (p) => p.kind === "partsNeeded",
    );
    expect(partsProblem?.status).toBe("resolved");
    expect(world.state.money.balance).toBe(500 - PRICE);
    expect(
      Object.values(world.state.money.transactions).filter((t) => t.reason === "purchase"),
    ).toHaveLength(1);
    expect(effectiveMarket(world.state, world.content, PORT)[PARTS]).toEqual({
      count: 1,
      price: PRICE,
    });
    expect(events.some((e) => e.type === "taskCompleted")).toBe(true);
    expect(events.some((e) => e.type === "faultRepaired")).toBe(true);
    expect(engineFaults(world, machineId)).toEqual([]);
    expect(world.state.work.problems[problemId]?.status).toBe("resolved");
    // The one unit bought was the one the repair consumed.
    expect(partsAboard(world)).toBe(0);
    expect(world.state.machines[machineId]?.condition).toBeGreaterThan(0.9);
  });

  it("buys nothing when the market has none, and nothing when the ship cannot pay", () => {
    for (const options of [
      { stock: 0, money: 500 },
      { stock: 2, money: PRICE - 1 },
    ]) {
      const tw = marketWorld(options);
      const { problemId } = addEngineFault(tw.world);
      const events = run(tw, TWO_MINUTES);
      expect(events.some((e) => e.type === "partsBought")).toBe(false);
      expect(tw.world.state.money.balance).toBe(options.money);
      expect(openPartsNeeded(tw.world)).toHaveLength(1);
      expect(tw.world.state.work.problems[problemId]?.status).toBe("open");
      expect(partsAboard(tw.world)).toBe(0);
      expect(effectiveMarket(tw.world.state, tw.world.content, PORT)[PARTS]?.count).toBe(
        options.stock,
      );
    }
  });

  it("stockMarket (narrator) makes the part available, and count 0 withdraws it", () => {
    const tw = marketWorld({ stock: 0, money: 500 });
    const { kernel, world } = tw;
    const { problemId } = addEngineFault(world);
    run(tw, 60);
    expect(openPartsNeeded(world)).toHaveLength(1);

    const accepted = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "stockMarket",
        payload: { portId: PORT, itemDefId: PARTS, count: 2, price: 90 },
      }),
    );
    expect(accepted.status).toBe("accepted");
    const events = run(
      tw,
      TWO_MINUTES,
      (w) => w.state.work.problems[problemId]?.status === "resolved",
    );
    expect(events.some((e) => e.type === "marketStocked")).toBe(true);
    expect(events.find((e) => e.type === "partsBought")).toMatchObject({
      payload: { count: 1, cost: 90 },
    });
    expect(world.state.money.balance).toBe(500 - 90);
    expect(world.state.markets[PORT]?.[PARTS]).toEqual({ count: 1, price: 90 });

    kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "stockMarket",
        payload: { portId: PORT, itemDefId: PARTS, count: 0, price: 90 },
      }),
    );
    run(tw, 2);
    expect(world.state.markets[PORT]?.[PARTS]).toEqual({ count: 0, price: 90 });
  });

  it("stockMarket is bounded and narrator-only", () => {
    const { kernel, world } = marketWorld();
    const tooMany = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "stockMarket",
        payload: { portId: PORT, itemDefId: PARTS, count: 5, price: 10 },
      }),
    );
    expect(tooMany).toMatchObject({ status: "rejected", rejection: { code: "outOfBounds" } });
    const unknownItem = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "stockMarket",
        payload: { portId: PORT, itemDefId: "item.test.nope" as ItemDefId, count: 1, price: 10 },
      }),
    );
    expect(unknownItem).toMatchObject({ status: "rejected", rejection: { code: "unknownEntity" } });
    const unknownPort = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "stockMarket",
        payload: { portId: "port.test.nope" as PortDefId, itemDefId: PARTS, count: 1, price: 10 },
      }),
    );
    expect(unknownPort).toMatchObject({ status: "rejected", rejection: { code: "unknownEntity" } });
    const player = kernel.enqueueCommand(
      world,
      cmd({
        source: "player",
        kind: "stockMarket",
        payload: { portId: PORT, itemDefId: PARTS, count: 1, price: 10 },
      }),
    );
    expect(player).toMatchObject({ status: "rejected", rejection: { code: "unauthorized" } });
    expect(world.state.money.balance).toBe(500);
  });

  it("reads a port's market from content when the save never seeded it (old saves)", () => {
    const { world } = marketWorld({ stock: 3 });
    delete world.state.markets[PORT];
    expect(effectiveMarket(world.state, world.content, PORT)).toEqual({
      [PARTS]: { count: 3, price: PRICE },
    });
  });
});

describe("parts market and the departure gate (D36, D47)", () => {
  it("a hold for repairs waits docked until the part is bought and fitted, then lifts", () => {
    const tw = marketWorld({ stock: 0, money: 500, travel: true });
    const { kernel, world } = tw;
    const { machineId } = addEngineFault(world);
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: TINY.port2 } }),
    );
    // The gate card: ack its narration hook, then choose "Hold for repairs" (left).
    run(tw, 200, (w) => w.state.decisions.queue.length > 0);
    run(tw, 5);
    const decisionId = world.state.decisions.queue[0];
    if (decisionId === undefined) throw new Error("no gate decision queued");
    expect(world.state.decisions.records[decisionId]?.prompt.key).toBe("travel.departureGate");
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "resolveDecision", payload: { decisionId, side: "left" } }),
    );

    // Nothing to buy here: the ship waits at the dock with the course kept.
    const waiting = run(tw, 20 * 30);
    expect(waiting.some((e) => e.type === "departureHeld")).toBe(true);
    expect(world.state.travel).toMatchObject({
      stage: "docked",
      portId: PORT,
      plannedDestinationId: TINY.port2,
      holdForRepairs: true,
    });
    expect(openPartsNeeded(world)).toHaveLength(1);
    expect(engineFaults(world, machineId)).toHaveLength(1);

    // The narrator stocks the part; the crew buy it, fix the engine, and the hold lifts.
    kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "stockMarket",
        payload: { portId: PORT, itemDefId: PARTS, count: 1, price: PRICE },
      }),
    );
    const released = run(tw, TWO_MINUTES, (w) => w.state.travel.stage !== "docked");
    expect(released.some((e) => e.type === "partsBought")).toBe(true);
    expect(released.some((e) => e.type === "faultRepaired")).toBe(true);
    expect(released.find((e) => e.type === "departureHoldLifted")).toMatchObject({
      payload: { toPortId: TINY.port2 },
    });
    expect(world.state.travel.stage).not.toBe("docked");
    expect(world.state.travel.holdForRepairs).toBeUndefined();
    expect(world.state.money.balance).toBe(500 - PRICE);
  });
});
