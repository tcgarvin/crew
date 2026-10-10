/**
 * §offered-freight test fixture: the dockside world (`travel/fixtures-dock.ts`: the crew deck with
 * two south ramps and the spike's quay at both `TINY.port` and `TINY.port2`) with the quays
 * furnished for port work, and commerce, equipment and travel registered alongside spatial, needs,
 * work and the planner.
 *
 * Both quays, in the dock's own frame (shipAt (2,1), so deck = dock − (2,1)):
 *
 *   dx 0123456789ABCDEF
 *    8 ................   ramps land at dock (4,8) cargo and (11,8) personnel
 *    9 ..........bbb...   b = delivery bay, deck (8..10, 8)
 *   10 ...sss.ccc..^...   s = staging, deck (1..3, 9..10); ^ = the stall's counter (12,10)
 *   11 G..sss......S..W   G = gate deck (−2, 10); S = market stall (home only); W = warehouse door
 *
 * The far quay has no stall, so its market is through the gate.
 */
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { Command } from "../../core/types/commands";
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type {
  CastSeedDef,
  ConfigDef,
  ContentBundle,
  DockDef,
  MachineDef,
} from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { CommandId, CrewDefId, ItemDefId, JobId, PortDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { registerPlannerDefaults } from "../../planner/index";
import { dirtViolations } from "../dirt/invariants";
import { registerEquipmentSystems } from "../equipment/register";
import { registerNeeds } from "../needs/index";
import { DECK12 } from "../spatial/fixtures/deck-12x8";
import { registerSpatial } from "../spatial/index";
import { spatialViolations } from "../spatial/invariants";
import {
  FAR_DOCK,
  HOME_DOCK,
  ackHook,
  docksideConfig,
  docksideContent,
} from "../travel/fixtures-dock";
import { registerTravel } from "../travel/index";
import { travelViolations } from "../travel/invariants";
import { ALL_DERIVATIONS, CREW } from "../work/fixtures/crew-deck";
import { registerWork } from "../work/index";
import { workViolations } from "../work/invariants";
import { registerCommerce } from "./index";
import { commerceViolations } from "./invariants";
import { PASSENGER_CREW_DEF_ID } from "./passage";

export const PARTS = "item.test.parts" as ItemDefId;
/**
 * §hand-truck-trips: the test hand truck, stowed in the hold zone (deck (10,6)) when `truck` is
 * set.
 */
export const TRUCK = "item.test.hand_truck" as ItemDefId;
export const PARTS_PRICE = 120;

/** Deck-frame tiles of the furnished quays. */
export const QUAY_WORK = {
  gate: { x: -2, y: 10 },
  stallCounter: { x: 10, y: 9 },
  staging: [
    { x: 1, y: 9 },
    { x: 2, y: 9 },
    { x: 3, y: 9 },
    { x: 1, y: 10 },
    { x: 2, y: 10 },
    { x: 3, y: 10 },
  ],
  bay: [
    { x: 8, y: 8 },
    { x: 9, y: 8 },
    { x: 10, y: 8 },
  ],
  /** The cargo ramp's top, aboard: where bought parts are set down. */
  cargoRampTop: { x: 2, y: 6 },
} as const satisfies Record<string, TileCoord | readonly TileCoord[]>;

/** The quay's warehouse door: where dock hands come and go (§dock-hand-errands). */
export const WAREHOUSE_DOOR = { x: 15 - 2, y: 11 - 1 } as const;

function furnished(dock: DockDef, stall: boolean, door: boolean): DockDef {
  return {
    ...dock,
    posts: [
      { key: "gate", kind: "gate", name: "the gate", tile: { x: 0, y: 11 }, facing: "e" },
      ...(door
        ? [
            {
              key: "door",
              kind: "warehouseDoor" as const,
              name: "the warehouse door",
              tile: { x: 15, y: 11 },
              facing: "w" as const,
            },
          ]
        : []),
      ...(stall
        ? [
            {
              key: "stall",
              kind: "marketStall" as const,
              name: "the stall",
              tile: { x: 12, y: 11 },
              facing: "n" as const,
            },
          ]
        : []),
    ],
    areas: [
      { key: "staging", kind: "freightStaging", rect: { x: 3, y: 10, w: 3, h: 2 } },
      { key: "bay", kind: "deliveryBay", rect: { x: 10, y: 9, w: 3, h: 1 } },
    ],
  };
}

export interface DockWorkOptions {
  /** Whether the home quay has a market stall (default true). */
  readonly homeStall?: boolean;
  readonly money?: number;
  readonly partsStock?: number;
  /** §hand-truck-trips: put a hand truck of this capacity in the hold (default: no truck). */
  readonly truck?: number;
  /**
   * §dock-hand-errands: give both quays a warehouse door, so dock hands cart the freight on foot
   * (default false: no door, so the instant carting these tests were written against).
   */
  readonly dockHands?: boolean;
  /**
   * §locals-table: regulars per port (`castSeed`, with posts on the quay: "gate", "door", "stall").
   */
  readonly castSeed?: Readonly<Record<string, readonly CastSeedDef[]>>;
}

/** A misfire whose repair consumes one `PARTS`, as the market test has it. */
function hungryEngine(engine: MachineDef): MachineDef {
  return {
    ...engine,
    faults: engine.faults.map((fault) => ({
      ...fault,
      repair: {
        steps: fault.repair.steps.map((step) => ({
          ...step,
          consumes: [{ itemDefId: PARTS, count: 1 }],
        })),
      },
    })),
  };
}

export function dockWorkContent(
  options: DockWorkOptions = {},
  config: ConfigDef = docksideConfig(),
): ContentBundle {
  const base = docksideContent(config);
  const doors = options.dockHands === true;
  const home = furnished(HOME_DOCK, options.homeStall ?? true, doors);
  const far = furnished(FAR_DOCK, false, doors);
  const engine = base.machines[CREW.engine];
  const mara = base.crew[TINY.mara];
  const scenario = base.scenarios[CREW.scenario2];
  if (engine === undefined || mara === undefined || scenario === undefined) {
    throw new Error("dockside fixture changed");
  }
  const market = [{ itemDefId: PARTS, count: options.partsStock ?? 2, price: PARTS_PRICE }];
  const ports = Object.fromEntries(
    Object.entries(base.ports).map(([id, port]) => [
      id,
      { ...port, market, castSeed: options.castSeed?.[id] ?? port.castSeed },
    ]),
  ) as ContentBundle["ports"];
  return {
    ...base,
    docks: { [home.id]: home, [far.id]: far },
    machines: { ...base.machines, [CREW.engine]: hungryEngine(engine) },
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
      [TRUCK]: {
        id: TRUCK,
        name: "Hand Truck",
        stacking: "unique",
        maxStack: 1,
        tags: ["tool"],
        toolKinds: ["handTruck"],
        mass: 6,
        capacityUnits: options.truck ?? 4,
      },
    },
    crew: {
      ...base.crew,
      [PASSENGER_CREW_DEF_ID]: {
        ...mara,
        id: PASSENGER_CREW_DEF_ID as CrewDefId,
        name: "Passenger",
        roleTags: [],
        skills: {},
        startingInventory: [],
      },
    },
    ports,
    scenarios: {
      ...base.scenarios,
      [CREW.scenario2]: {
        ...scenario,
        startingMoney: options.money ?? 5000,
        startingItems: [
          ...scenario.startingItems,
          ...(options.truck === undefined ? [] : [{ itemDefId: TRUCK, count: 1, zoneKey: "hold" }]),
        ],
      },
    },
    hash: "dock-work-v1",
  };
}

/** Spatial, equipment, travel, commerce, needs, work and the planner, on `dockWorkContent`. */
export function dockWorkWorld(
  options: DockWorkOptions = {},
  config: ConfigDef = docksideConfig(),
): TestWorld {
  const registry = createRegistry();
  registerSpatial(registry);
  registerEquipmentSystems(registry);
  registerTravel(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerWork(registry, { derivations: ALL_DERIVATIONS });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    CREW.scenario2,
    11,
    dockWorkContent(options, config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

let n = 0;

export function send(test: TestWorld, command: Omit<Command, "id">): void {
  n += 1;
  const result = test.kernel.enqueueCommand(test.world, {
    ...command,
    id: `cmd:dock-work:${n}` as CommandId,
  } as Command);
  if (result.status !== "accepted") {
    throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
  }
}

/** Offer `count` crates from `from` to `to` (no card), returning the new job's id. */
export function offerFreight(
  test: TestWorld,
  from: PortDefId = TINY.port,
  to: PortDefId = TINY.port2,
  count = 3,
): JobId {
  const before = new Set(Object.keys(test.world.state.jobs));
  send(test, {
    source: "scenario",
    kind: "offerJob",
    payload: {
      job: {
        issuer: { name: "Test Shipper", role: "shipper" },
        description: { key: "test.job", params: {} },
        fromPortId: from,
        toPortId: to,
        cargo: [{ itemDefId: TINY.crate, count }],
        pay: 30 * count * 2,
      },
      surface: false,
    },
  });
  test.kernel.advance(test.world, 1);
  const id = Object.keys(test.world.state.jobs).find((jobId) => !before.has(jobId));
  if (id === undefined) throw new Error("offerJob made no job");
  return id as JobId;
}

/** Deck-frame tile of an on-deck location; undefined anywhere else. */
export function tileAt(location: PhysicalLocation | undefined): TileCoord | undefined {
  if (location?.kind !== "onDeck" || location.deckId !== DECK12.deck) return undefined;
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

/** Was this tile one of `tiles`? */
export const onTile = (tiles: readonly TileCoord[], tile: TileCoord | undefined): boolean =>
  tile !== undefined && tiles.some((t) => t.x === tile.x && t.y === tile.y);

/** One sim-minute in ticks (20 Hz). */
export const MINUTE = 20 * 60;

/** Step tick by tick, acknowledging hooks, checking every invariant, until `until` or `ticks`. */
export function run(
  test: TestWorld,
  ticks: number,
  until?: (world: World) => boolean,
  each?: (world: World) => void,
): SimEvent[] {
  const { kernel, world } = test;
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    ackHook(test);
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...dirtViolations(world),
      ...workViolations(world),
      ...travelViolations(world),
      ...commerceViolations(world),
    ];
    if (violations.length > 0) {
      throw new Error(`tick ${world.state.tick}: ${violations.slice(0, 5).join("; ")}`);
    }
    each?.(world);
    if (until?.(world)) break;
  }
  return events;
}

export function accept(test: TestWorld, id: JobId): void {
  send(test, { source: "player", kind: "acceptContract", payload: { jobId: id } });
}

export function setCourse(test: TestWorld, to = TINY.port2): void {
  send(test, { source: "player", kind: "setCourse", payload: { destinationPortId: to } });
}
