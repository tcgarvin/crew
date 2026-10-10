/**
 * §reserve-kinds: the ship's stores, kept through the port market. Food is reckoned in days of the
 * crew's hunger; below the reserve, docked at a port that sells food, commerce raises `reserveLow`
 * (owner commerce, routine) and the crew buy the shortfall through the `buyParts` task
 * (§buying-parts), in stacks no bigger than the item's `maxStack`. Underway, or where nothing is
 * for sale, there is no problem to show.
 */
import { describe, expect, it } from "vitest";
import { type TestWorld, cmd } from "../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { HookId, ItemDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { registerPlannerDefaults } from "../../planner/index";
import { DAMAGE, damageWorld } from "../damage/fixtures/damage-deck";
import { registerEquipmentSystems } from "../equipment/register";
import { registerNeeds } from "../needs/index";
import { registerSpatial } from "../spatial/index";
import { spatialViolations } from "../spatial/invariants";
import { PORTS } from "../travel/fixtures";
import {
  ALL_DERIVATIONS,
  CREW,
  JON,
  MARA,
  crewConfig,
  crewContent,
  place,
} from "../work/fixtures/crew-deck";
import { registerWork } from "../work/index";
import { workViolations } from "../work/invariants";
import { registerCommerce } from "./index";
import { foodDaysAboard, reserveShortfalls, stockedPatchKits } from "./reserve";

const PORT = TINY.port;
const RATION_PRICE = 2;
const SPARES = "item.test.spares" as ItemDefId;
const SPARE_PRICE = 50;

interface ReserveOptions {
  /** Rations the dock's market sells (no line at all when undefined). */
  readonly rationStock?: number;
  readonly lowBelowDays?: number;
  readonly restockToDays?: number;
  /** Spares the dock's market sells (no line at all when undefined). */
  readonly spareStock?: number;
  readonly sparesReserve?: number;
}

function reserveConfig(options: ReserveOptions): ConfigDef {
  const base = crewConfig();
  return {
    ...base,
    commerce: {
      ...base.commerce,
      sparesReserve: options.sparesReserve ?? 0,
      foodReserve: {
        lowBelowDays: options.lowBelowDays ?? 4,
        restockToDays: options.restockToDays ?? 6,
      },
    },
  };
}

/** Crew deck (two aboard, ten rations at 0.3 each), the dock sells `rationStock` rations. */
function reserveContent(config: ConfigDef, options: ReserveOptions): ContentBundle {
  const base = crewContent(config);
  const port = base.ports[PORT];
  const scenario = base.scenarios[CREW.scenario2];
  if (port === undefined || scenario === undefined) throw new Error("crew-deck fixture changed");
  return {
    ...base,
    ports: {
      ...base.ports,
      [PORT]: {
        ...port,
        market: [
          ...(options.rationStock === undefined
            ? []
            : [{ itemDefId: TINY.rations, count: options.rationStock, price: RATION_PRICE }]),
          ...(options.spareStock === undefined
            ? []
            : [{ itemDefId: SPARES, count: options.spareStock, price: SPARE_PRICE }]),
        ],
      },
    },
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
    scenarios: { ...base.scenarios, [CREW.scenario2]: { ...scenario, startingMoney: 500 } },
    hash: "reserve-test-v1",
  };
}

function reserveWorld(options: ReserveOptions = {}): TestWorld {
  const config = reserveConfig(options);
  const registry = createRegistry();
  registerSpatial(registry);
  registerEquipmentSystems(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerWork(registry, { derivations: ALL_DERIVATIONS });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    CREW.scenario2,
    11,
    reserveContent(config, options),
    tinyEffectiveConfig(config),
  );
  place(world, MARA, { x: 3, y: 6 });
  place(world, JON, { x: 9, y: 3 });
  return { registry, kernel, world };
}

/** Step tick by tick, acknowledging hooks and checking invariants; stops on `until`. */
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
    }
    if (until?.(world)) break;
  }
  return events;
}

function reserveProblems(world: World) {
  return Object.values(world.state.work.problems).filter((p) => p.kind === "reserveLow");
}

function rationStacks(world: World): number[] {
  return Object.values(world.state.items)
    .filter((i) => i.defId === TINY.rations && i.location.kind !== "inExternalStore")
    .map((i) => (i.stacking === "stack" ? i.count : 1));
}

const TWO_MINUTES = 20 * 120;

describe("food reserve (§reserve-kinds): days of the crew's hunger aboard", () => {
  it("counts the nutrition aboard over the eaters' hunger per day", () => {
    const { world } = reserveWorld({ rationStock: 40 });
    const ctx = { state: world.state, content: world.content, config: world.config.values };
    // Ten rations at 0.3 for two people at 0.001/s over a 600 s day (0.6 a day each).
    expect(foodDaysAboard(ctx)).toBeCloseTo((10 * 0.3) / (2 * 0.6));
    for (const actor of Object.values(world.state.actors)) actor.availability = "offShip";
    expect(foodDaysAboard(ctx)).toBe(Number.POSITIVE_INFINITY);
  });

  it("wants the shortfall to the restock level of a food the market here sells", () => {
    const { world } = reserveWorld({ rationStock: 40 });
    const ctx = { state: world.state, content: world.content, config: world.config.values };
    // 2.5 days aboard, restock to 6: 3.5 days × 1.2 hunger a day / 0.3 a ration.
    expect(reserveShortfalls(ctx, PORT)).toEqual([{ itemDefId: TINY.rations, count: 14 }]);
    const fed = reserveWorld({ rationStock: 40, lowBelowDays: 2 });
    const fedCtx = {
      state: fed.world.state,
      content: fed.world.content,
      config: fed.world.config.values,
    };
    expect(reserveShortfalls(fedCtx, PORT)).toEqual([]);
    const bare = reserveWorld({ rationStock: 0 });
    const bareCtx = {
      state: bare.world.state,
      content: bare.world.content,
      config: bare.world.config.values,
    };
    expect(reserveShortfalls(bareCtx, PORT)).toEqual([]);
  });

  it("raises reserveLow while docked at a port that sells food, and none where none is sold", () => {
    const tw = reserveWorld({ rationStock: 40 });
    run(tw, 2);
    const open = reserveProblems(tw.world).filter((p) => p.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      owner: "commerce",
      visibility: "public",
      baseUrgency: "routineObligation",
      payload: { itemDefId: TINY.rations },
      location: { kind: "port", portId: PORT },
    });

    const none = reserveWorld({});
    run(none, 20);
    expect(reserveProblems(none.world)).toEqual([]);
  });

  it("the crew buy the food at the dock, in stacks no bigger than maxStack, and it settles", () => {
    const tw = reserveWorld({ rationStock: 40 });
    const { world } = tw;
    const before = rationStacks(world).reduce((a, b) => a + b, 0);
    const events = run(tw, TWO_MINUTES, (w) =>
      reserveProblems(w).some((p) => p.status === "resolved"),
    );
    const bought = events.find((e) => e.type === "partsBought");
    expect(bought).toMatchObject({ payload: { portId: PORT, itemDefId: TINY.rations } });
    const count = bought?.type === "partsBought" ? bought.payload.count : 0;
    expect(count).toBeGreaterThan(10);
    expect(world.state.money.balance).toBe(500 - count * RATION_PRICE);
    const maxStack = world.content.items[TINY.rations]?.maxStack ?? 0;
    expect(Math.max(...rationStacks(world))).toBeLessThanOrEqual(maxStack);
    // Some may have been eaten meanwhile; the purchase is aboard.
    expect(rationStacks(world).reduce((a, b) => a + b, 0)).toBeGreaterThan(before);
    run(tw, 20);
    expect(reserveProblems(world).filter((p) => p.status === "open")).toEqual([]);
  });
});

describe("spares reserve (§reserve-kinds): units of each spare kept aboard", () => {
  function sparesAboard(world: World): number {
    return Object.values(world.state.items)
      .filter((i) => i.defId === SPARES && i.location.kind !== "inExternalStore")
      .reduce((n, i) => n + (i.stacking === "stack" ? i.count : 1), 0);
  }

  it("wants the shortfall to the reserve of each spare the market here sells", () => {
    const { world } = reserveWorld({ spareStock: 4, sparesReserve: 2 });
    const ctx = { state: world.state, content: world.content, config: world.config.values };
    expect(reserveShortfalls(ctx, PORT)).toEqual([{ itemDefId: SPARES, count: 2 }]);
    const off = reserveWorld({ spareStock: 4, sparesReserve: 0 });
    const offCtx = {
      state: off.world.state,
      content: off.world.content,
      config: off.world.config.values,
    };
    expect(reserveShortfalls(offCtx, PORT)).toEqual([]);
  });

  it("the crew buy the reserve with nothing broken, and nothing more once it is aboard", () => {
    const tw = reserveWorld({ spareStock: 4, sparesReserve: 2 });
    const { world } = tw;
    run(tw, 2);
    expect(reserveProblems(world).filter((p) => p.status === "open")).toMatchObject([
      { baseUrgency: "routineObligation", payload: { itemDefId: SPARES, count: 2 } },
    ]);
    const events = run(tw, TWO_MINUTES, (w) =>
      reserveProblems(w).some((p) => p.status === "resolved"),
    );
    expect(events.find((e) => e.type === "partsBought")).toMatchObject({
      payload: { itemDefId: SPARES, count: 2, cost: 2 * SPARE_PRICE },
    });
    expect(sparesAboard(world)).toBe(2);
    run(tw, 200);
    expect(reserveProblems(world).filter((p) => p.status === "open")).toEqual([]);
    expect(sparesAboard(world)).toBe(2);
    expect(world.state.money.balance).toBe(500 - 2 * SPARE_PRICE);
  });

  it("raises nothing where the market has no spares", () => {
    const tw = reserveWorld({ spareStock: 0, sparesReserve: 2 });
    run(tw, 20);
    expect(reserveProblems(tw.world)).toEqual([]);
  });
});

describe("patch kits: bought back to the scenario's stocked count", () => {
  function kitWorld(options: Parameters<typeof damageWorld>[0]) {
    const { world } = damageWorld(options);
    const ctx = { state: world.state, content: world.content, config: world.config.values };
    return { world, ctx };
  }

  it("stocks two a locker, and wants nothing while they are all aboard", () => {
    const { ctx } = kitWorld({ kitStock: { count: 20, price: 15 } });
    expect(stockedPatchKits(ctx)).toBe(10);
    expect(reserveShortfalls(ctx, PORTS.a)).toEqual([]);
  });

  it("wants the kits spent, from a market that sells them, and none where none are sold", () => {
    const { world, ctx } = kitWorld({ kitStock: { count: 20, price: 15 } });
    const [spent] = Object.values(world.state.items).filter((i) => i.defId === DAMAGE.kit);
    if (spent === undefined) throw new Error("no kits aboard");
    delete world.state.items[spent.id];
    expect(reserveShortfalls(ctx, PORTS.a)).toEqual([{ itemDefId: DAMAGE.kit, count: 2 }]);

    const bare = kitWorld({});
    const [gone] = Object.values(bare.world.state.items).filter((i) => i.defId === DAMAGE.kit);
    if (gone === undefined) throw new Error("no kits aboard");
    delete bare.world.state.items[gone.id];
    expect(reserveShortfalls(bare.ctx, PORTS.a)).toEqual([]);
  });

  it("wants none on a ship the scenario stocked with none", () => {
    const { ctx } = kitWorld({ kits: false, kitStock: { count: 20, price: 15 } });
    expect(stockedPatchKits(ctx)).toBe(0);
    expect(reserveShortfalls(ctx, PORTS.a)).toEqual([]);
  });
});
