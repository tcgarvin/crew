/**
 * W1 test fixture (D77): a small ship with a bridge, for the watch and the helm. Three rooms in a
 * row joined by doorless openings: an airlock with the ramp and the gangway post, a mess with
 * rations, and the bridge with the helm (seat and standby) and a nav terminal.
 *
 *   x 0123456789ABCD
 *   0 LLLMMMMMBNBBBB     N = nav terminal (9,0), operated from (9,1)
 *   1 rgLMMMMMBBBBsH     H = helm (13,1): seat (12,1), standby (13,2); r = ramp, west of (0,1)
 *   2 LLLMMMMMBBBBBs     g = gangway post (1,1); rations at (5,0)
 *
 * Crew, in actor order: a1 Noor (pilot, piloting 3), a2 Mara (captain, 6), a3 Priya (engineer,
 * 1), a4 Jax (pilot, 8), a5 Dane (first officer, 4), a6 Bettina (cook, 1). The bill: Red = Noor,
 * Mara, Priya; White = Jax; Blue = Dane; Bettina a dayworker. A 300 s day of three 100 s watches.
 * Needs do not move unless a test sets them. Travel and ports are the freight fixture's.
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { TileCoord } from "../../../core/types/common";
import type {
  ConfigDef,
  ContentBundle,
  CrewDef,
  MachineDef,
  WatchBillDef,
} from "../../../core/types/content";
import type {
  ActorId,
  CrewDefId,
  DeckDefId,
  ItemDefId,
  MachineDefId,
  ScenarioDefId,
} from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import { registerPlannerDefaults } from "../../../planner/index";
import { registerNeeds } from "../../needs/index";
import { registerSpatial } from "../../spatial/index";
import {
  PORTS,
  fixtureConfig,
  fixtureContent,
  fixtureEffectiveConfig,
} from "../../travel/fixtures";
import { registerTravel } from "../../travel/index";
import { travelTaskDerivations } from "../../travel/tasks";
import { registerWork } from "../../work/index";
import { registerWatch } from "../index";

export const BRIDGE = {
  deck: "deck.bridge.test" as DeckDefId,
  helm: "machine.bridge.helm" as MachineDefId,
  nav: "machine.bridge.nav" as MachineDefId,
  rations: "item.bridge.rations" as ItemDefId,
  scenario: "scenario.bridge.test" as ScenarioDefId,
  noor: "crew.bridge.noor" as CrewDefId,
  mara: "crew.bridge.mara" as CrewDefId,
  priya: "crew.bridge.priya" as CrewDefId,
  jax: "crew.bridge.jax" as CrewDefId,
  dane: "crew.bridge.dane" as CrewDefId,
  bettina: "crew.bridge.bettina" as CrewDefId,
} as const;

/** Actor ids, in the scenario's crew order. */
export const NOOR = "a1" as ActorId;
export const MARA = "a2" as ActorId;
export const PRIYA = "a3" as ActorId;
export const JAX = "a4" as ActorId;
export const DANE = "a5" as ActorId;
export const BETTINA = "a6" as ActorId;

export const SEAT: TileCoord = { x: 12, y: 1 };
export const STANDBY: TileCoord = { x: 13, y: 2 };
export const GANGWAY: TileCoord = { x: 1, y: 1 };
export const RATIONS_TILE: TileCoord = { x: 5, y: 0 };

export const BRIDGE_DAY = 300;

/** The bill this fixture is written against. */
export const BRIDGE_BILL: WatchBillDef = {
  sections: [
    { key: "red", members: [BRIDGE.noor, BRIDGE.mara, BRIDGE.priya] },
    { key: "white", members: [BRIDGE.jax] },
    { key: "blue", members: [BRIDGE.dane] },
  ],
  dayworkers: [BRIDGE.bettina],
};

/** The freight fixture's config on a 300 s day of three watches, needs still. */
export function bridgeConfig(): ConfigDef {
  const base = fixtureConfig({ quietTooLongSeconds: 1_000_000 });
  return {
    ...base,
    time: { ...base.time, daySeconds: BRIDGE_DAY, watchesPerDay: 3 },
    needs: {
      ...base.needs,
      hungerPerDay: 0,
      fatiguePerDayAwake: 0,
      fatiguePerDayWorking: 0,
      comfortPerDay: 0,
      socialPerDay: 0,
      mealDays: 4 / BRIDGE_DAY,
    },
    // A relief lasts up to 120 s, as on the authored 1200 s day.
    watches: {
      ...base.watches,
      dayworkerOnWatches: [0, 1],
      reliefMaxDays: 120 / BRIDGE_DAY,
      plotCourseSeconds: 2,
    },
  };
}

const still = {
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
} as const;

const helmDef: MachineDef = {
  id: BRIDGE.helm,
  name: "Helm",
  tags: ["pilotStation"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [
    { key: "seat", offset: { x: -1, y: 0 }, purposes: ["operate", "repair"], capacity: 1 },
    { key: "standby", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 },
  ],
  operation: { requiresOperator: true, operatorSkill: { skill: "piloting", min: 3 } },
  ...still,
};

const navDef: MachineDef = {
  id: BRIDGE.nav,
  name: "Nav Terminal",
  tags: ["navStation"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [
    { key: "seat", offset: { x: 0, y: 1 }, purposes: ["operate"], capacity: 1 },
  ],
  operation: { requiresOperator: false },
  ...still,
};

function crewDef(
  id: CrewDefId,
  name: string,
  roleTags: CrewDef["roleTags"],
  piloting: number,
): CrewDef {
  return {
    id,
    name,
    roleTags,
    skills: { piloting },
    startingInventory: [],
    bio: "Bridge fixture crew.",
    voice: "Plain and brief.",
  };
}

const ROWS = ["LLLMMMMMBBBBBB", "LLLMMMMMBBBBBB", "LLLMMMMMBBBBBB"];

export function bridgeContent(
  config: ConfigDef = bridgeConfig(),
  bill: WatchBillDef = BRIDGE_BILL,
): ContentBundle {
  const base = fixtureContent(config);
  const openings = [0, 1, 2].flatMap((y) => [
    { x: 2, y, side: "e" as const },
    { x: 7, y, side: "e" as const },
  ]);
  const crew = [
    crewDef(BRIDGE.noor, "Noor Haddad", ["pilot"], 3),
    crewDef(BRIDGE.mara, "Mara Osei", ["captain"], 6),
    crewDef(BRIDGE.priya, "Priya Kessler", ["engineer"], 1),
    crewDef(BRIDGE.jax, "Jax Okonkwo", ["pilot"], 8),
    crewDef(BRIDGE.dane, "Dane Whitcross", ["firstOfficer"], 4),
    crewDef(BRIDGE.bettina, "Bettina Solheim", ["cook"], 1),
  ];
  return {
    ...base,
    decks: {
      [BRIDGE.deck]: {
        id: BRIDGE.deck,
        name: "Bridge test deck",
        width: 14,
        height: 3,
        tiles: ROWS,
        compartments: [
          { key: "airlock", symbol: "L", name: "Airlock", tags: ["airlock"] },
          { key: "mess", symbol: "M", name: "Mess", tags: ["mess", "galley", "quarters"] },
          { key: "bridge", symbol: "B", name: "Bridge", tags: ["bridge"] },
        ],
        doors: [
          {
            key: "ramp",
            edge: { x: 0, y: 1, side: "w" },
            kind: "ramp",
            manualOperationSupported: true,
            initialState: "closed",
          },
        ],
        openings,
        walls: [],
        machines: [
          { key: "helm", machineDefId: BRIDGE.helm, origin: { x: 13, y: 1 }, rotation: 0 },
          { key: "nav", machineDefId: BRIDGE.nav, origin: { x: 9, y: 0 }, rotation: 0 },
        ],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [
          { key: "gangway", name: "Gangway Post", tags: ["gangway"], tiles: [GANGWAY] },
          { key: "galley", name: "Galley counter", tags: [], tiles: [RATIONS_TILE] },
          {
            key: "stowage",
            name: "Cargo stowage",
            tags: ["cargoStowage"],
            tiles: [{ x: 4, y: 2 }],
          },
        ],
        docking: {
          cargoRampDoorKey: "ramp",
          personnelRampDoorKey: "ramp",
          cargoTransferTiles: [{ x: 0, y: 1 }],
          personnelTransferTiles: [{ x: 0, y: 1 }],
        },
        hull: { class: "test_hull", sizeClass: "S", max: 100 },
        spawnPoints: [3, 4, 5, 6, 7].flatMap((x) => [
          { key: `mess${x}a`, tile: { x, y: 1 }, tags: ["crew"] },
          { key: `mess${x}b`, tile: { x, y: 2 }, tags: ["crew"] },
        ]),
      },
    },
    machines: { [BRIDGE.helm]: helmDef, [BRIDGE.nav]: navDef },
    items: {
      ...base.items,
      [BRIDGE.rations]: {
        id: BRIDGE.rations,
        name: "Ration pack",
        stacking: "stackable",
        maxStack: 20,
        tags: ["food", "consumable"],
        toolKinds: [],
        mass: 0.5,
        nutrition: 0.8,
      },
    },
    crew: Object.fromEntries(crew.map((def) => [def.id, def])),
    scenarios: {
      [BRIDGE.scenario]: {
        id: BRIDGE.scenario,
        name: "Bridge",
        deckId: BRIDGE.deck,
        startPortId: PORTS.a,
        crew: crew.map((def) => def.id),
        startingMoney: 0,
        startingItems: [{ itemDefId: BRIDGE.rations, count: 20, zoneKey: "galley" }],
        initialFaults: [],
        watchBill: bill,
      },
    },
    hash: "bridge-deck-v1",
  };
}

export interface BridgeWorldOptions {
  readonly config?: ConfigDef;
  readonly bill?: WatchBillDef;
  readonly seed?: number;
}

/** Spatial, travel, needs, the watch, work (travel's derivations) and the planner. */
export function bridgeWorld(options: BridgeWorldOptions = {}): TestWorld {
  const config = options.config ?? bridgeConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerWork(registry, { derivations: travelTaskDerivations });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    BRIDGE.scenario,
    options.seed ?? 7,
    bridgeContent(config, options.bill),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** Teleport a stationary actor to a tile centre (setup only). */
export function placeOnBridgeDeck(world: World, actorId: ActorId, tile: TileCoord): void {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: BRIDGE.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}
