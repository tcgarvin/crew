/**
 * W4a test fixture: W3's 12×8 deck, furnished. Room A is crew quarters with three bunks, room B
 * the galley/mess with a ration stack, room C engineering with the tiny coolant pump and a
 * wrench, the corridor holds the cargo stowage zone. Built on `deck12Content`.
 *
 *   x 0123456789AB
 *   0 ABBBBBBBCCCC    b = bunk footprints (1,0) (2,0) (3,0); berths (1,1) (2,1) (3,1)
 *   1 A...BrBBC.PC    r = ration stack (6,1); P = pump (10,1), repair position (9,1)
 *   2 AAAABBBBCwCC    w = wrench (9,2)
 *   3 AAAABBBBCCeE    E = engine (11,3), service position (10,3)
 *   4 AdAABbBBCCcC    doors on the south edge of (1,4) (5,4) (10,4)
 *   5 HHHHHHHHHHHH    crew spawn along row 5/6 west
 *   6 HHHHHHHHHHss    s = cargo stowage zone (10,6) (11,6)
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { TINY, tinyConfig, tinyEffectiveConfig } from "../../../core/fixtures/tiny-content";
import { allocateId } from "../../../core/ids";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { TileCoord } from "../../../core/types/common";
import type { ConfigDef, ContentBundle, CrewDef, MachineDef } from "../../../core/types/content";
import type {
  ActorId,
  CrewDefId,
  ItemDefId,
  ItemId,
  JobId,
  MachineDefId,
  MachineId,
  ProblemId,
  ScenarioDefId,
} from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { Problem } from "../../../core/types/work";
import { registerPlannerDefaults } from "../../../planner/index";
import { commerceTaskDerivations } from "../../commerce/tasks";
import { equipmentTaskDerivation } from "../../equipment/tasks";
import { registerNeeds } from "../../needs/index";
import { DECK12, deck12Content } from "../../spatial/fixtures/deck-12x8";
import { registerSpatial } from "../../spatial/index";
import { travelTaskDerivations } from "../../travel/tasks";
import { type RegisterWorkOptions, registerWork } from "../index";

export const CREW = {
  bunk: "machine.test.bunk" as MachineDefId,
  engine: "machine.test.engine" as MachineDefId,
  scenario2: "scenario.test.crew2" as ScenarioDefId,
  scenario8: "scenario.test.crew8" as ScenarioDefId,
  jon: DECK12.jon,
} as const;

export const MARA = "a1" as ActorId;
export const JON = "a2" as ActorId;

export const GALLEY_TILE: TileCoord = { x: 6, y: 1 };
export const WRENCH_TILE: TileCoord = { x: 9, y: 2 };
export const STOWAGE_TILES: readonly TileCoord[] = [
  { x: 10, y: 6 },
  { x: 11, y: 6 },
];

const bunkDef: MachineDef = {
  id: CREW.bunk,
  name: "Bunk",
  tags: ["bed"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [{ key: "berth", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 }],
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
};

const engineDef: MachineDef = {
  ...bunkDef,
  id: CREW.engine,
  name: "Engine",
  tags: ["engine"],
  interactionPositions: [
    { key: "service", offset: { x: -1, y: 0 }, purposes: ["repair", "operate"], capacity: 1 },
  ],
  faults: [
    {
      key: "misfire",
      name: "Misfire",
      weight: 1,
      effect: { kind: "derate", outputFactor: 0.5 },
      symptom: { key: "coughing", channel: "audible" },
      repair: {
        steps: [
          {
            key: "adjust",
            action: "repair",
            workSeconds: 5,
            tools: [],
            consumes: [],
            at: "repair",
          },
        ],
      },
    },
  ],
};

const EIGHT_NAMES = ["Ada Kim", "Bo Lindqvist", "Cy Mbeki", "Dee Park", "Eli Soto", "Fen Ward"];

function extraCrew(base: CrewDef): Record<CrewDefId, CrewDef> {
  const out: Record<CrewDefId, CrewDef> = {};
  EIGHT_NAMES.forEach((name, i) => {
    const id = `crew.test.extra${i}` as CrewDefId;
    out[id] = {
      ...base,
      id,
      name,
      roleTags: i % 2 === 0 ? ["engineer"] : ["deckhand"],
      skills: { engineering: i % 3, cargo: 2 + (i % 2) },
      startingInventory: [],
      shift: i % 2 === 0 ? "alpha" : "beta",
    };
  });
  return out;
}

/** Tiny config with a second (off-duty-at-start) shift. */
export function crewConfig(overrides: Partial<ConfigDef> = {}): ConfigDef {
  const base = tinyConfig();
  return {
    ...base,
    shifts: {
      cycleSeconds: 600,
      shifts: [
        { key: "alpha", workWindows: [[0, 300]] },
        { key: "beta", workWindows: [[300, 600]] },
      ],
    },
    ...overrides,
  };
}

export function crewContent(config: ConfigDef = crewConfig()): ContentBundle {
  const base = deck12Content(config);
  const deck = base.decks[DECK12.deck];
  const mara = base.crew[TINY.mara];
  const jon = base.crew[DECK12.jon];
  if (deck === undefined || mara === undefined || jon === undefined)
    throw new Error("deck12 fixture changed");
  const extras = extraCrew(mara);
  return {
    ...base,
    decks: {
      [DECK12.deck]: {
        ...deck,
        compartments: [
          { key: "roomA", symbol: "A", name: "Crew Quarters", tags: ["quarters"] },
          { key: "roomB", symbol: "B", name: "Galley", tags: ["galley", "mess"] },
          { key: "roomC", symbol: "C", name: "Engineering", tags: ["engineering"] },
          { key: "hall", symbol: "H", name: "Corridor", tags: ["corridor", "cargoHold"] },
        ],
        machines: [
          ...deck.machines,
          { key: "bunk1", machineDefId: CREW.bunk, origin: { x: 1, y: 0 }, rotation: 0 },
          { key: "bunk2", machineDefId: CREW.bunk, origin: { x: 2, y: 0 }, rotation: 0 },
          { key: "bunk3", machineDefId: CREW.bunk, origin: { x: 3, y: 0 }, rotation: 0 },
          { key: "engine1", machineDefId: CREW.engine, origin: { x: 11, y: 3 }, rotation: 0 },
        ],
        zones: [
          { key: "galley", name: "Galley counter", tags: ["galley"], tiles: [GALLEY_TILE] },
          { key: "engStores", name: "Engineering stores", tags: [], tiles: [WRENCH_TILE] },
          { key: "hold", name: "Cargo stowage", tags: ["cargoStowage"], tiles: [...STOWAGE_TILES] },
        ],
        docking: {
          ...deck.docking,
          cargoTransferTiles: [{ x: 0, y: 6 }],
          personnelTransferTiles: [{ x: 0, y: 6 }],
        },
      },
    },
    machines: { ...base.machines, [CREW.bunk]: bunkDef, [CREW.engine]: engineDef },
    crew: {
      ...base.crew,
      [TINY.mara]: { ...mara, startingInventory: [], skills: { piloting: 6, engineering: 2 } },
      [DECK12.jon]: { ...jon, skills: { engineering: 5, cargo: 3 } },
      ...extras,
    },
    scenarios: {
      [CREW.scenario2]: {
        id: CREW.scenario2,
        name: "Crew of two",
        deckId: DECK12.deck,
        startPortId: TINY.port,
        crew: [TINY.mara, DECK12.jon],
        startingMoney: 0,
        startingItems: [
          { itemDefId: TINY.rations, count: 10, zoneKey: "galley" },
          { itemDefId: TINY.wrench, count: 1, zoneKey: "engStores" },
        ],
        initialFaults: [],
      },
      [CREW.scenario8]: {
        id: CREW.scenario8,
        name: "Crew of eight",
        deckId: DECK12.deck,
        startPortId: TINY.port,
        crew: [TINY.mara, DECK12.jon, ...(Object.keys(extras) as CrewDefId[])],
        startingMoney: 0,
        startingItems: [
          { itemDefId: TINY.rations, count: 10, zoneKey: "galley" },
          { itemDefId: TINY.wrench, count: 1, zoneKey: "engStores" },
        ],
        initialFaults: [],
      },
    },
    hash: "crew-deck-v1",
  };
}

export const ALL_DERIVATIONS = {
  ...equipmentTaskDerivation,
  ...commerceTaskDerivations,
  ...travelTaskDerivations,
};

export interface CrewWorldOptions {
  readonly config?: ConfigDef;
  readonly scenario?: ScenarioDefId;
  readonly work?: RegisterWorkOptions;
  readonly seed?: number;
  /** Register extra systems (e.g. W5 equipment) before work. */
  readonly extra?: (registry: TestWorld["registry"]) => void;
}

/** Isolated registry: spatial, needs, work (all derivations), planner. */
export function crewWorld(options: CrewWorldOptions = {}): TestWorld {
  const config = options.config ?? crewConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  options.extra?.(registry);
  registerNeeds(registry);
  registerWork(registry, { derivations: ALL_DERIVATIONS, ...options.work });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    options.scenario ?? CREW.scenario2,
    options.seed ?? 11,
    crewContent(config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** Teleport a stationary actor to a tile centre (setup only). */
export function place(world: World, actorId: ActorId, tile: TileCoord): void {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: DECK12.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}

export function itemAt(world: World, defId: ItemDefId): ItemId {
  const item = Object.values(world.state.items).find((i) => i.defId === defId);
  if (item === undefined) throw new Error(`no item ${defId}`);
  return item.id;
}

export function machineByPlacement(world: World, key: string): MachineId {
  const machine = Object.values(world.state.machines).find((m) => m.placementKey === key);
  if (machine === undefined) throw new Error(`no machine ${key}`);
  return machine.id;
}

/** Insert a problem row as its owning system would. */
export function addProblem(world: World, problem: Omit<Problem, "id">): ProblemId {
  const id = allocateId(world.state, "problem");
  world.state.work.problems[id] = { ...problem, id } as Problem;
  return id;
}

/** A crate on the corridor floor with a `cargoToLoad` problem to stow it in the hold. */
export function addCrateToLoad(
  world: World,
  tile: TileCoord,
): { itemId: ItemId; problemId: ProblemId } {
  const itemId = allocateId(world.state, "item");
  world.state.items[itemId] = {
    id: itemId,
    defId: TINY.crate,
    stacking: "unique",
    condition: 1,
    location: { kind: "onDeck", deckId: DECK12.deck, x: tile.x + 0.5, y: tile.y + 0.5 },
  };
  world.caches.dirty.inventory = true;
  const problemId = addProblem(world, {
    kind: "cargoToLoad",
    payload: { jobId: "j1" as JobId, itemId, stowageZoneKey: "hold" },
    owner: "commerce",
    visibility: "public",
    dedupeKey: `cargoToLoad:j1:${itemId}`,
    status: "open",
    createdTick: world.state.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "tile", deckId: DECK12.deck, x: tile.x, y: tile.y },
  });
  return { itemId, problemId };
}

/** A `wornBearing` fault on the pump plus its `discovered` `machineSymptom` problem. */
export function addPumpSymptom(world: World): { machineId: MachineId; problemId: ProblemId } {
  const machineId = machineByPlacement(world, "pump1");
  const machine = world.state.machines[machineId];
  if (machine === undefined) throw new Error("no pump");
  machine.faults.push({
    faultKey: "wornBearing",
    sinceTick: world.state.tick,
    diagnosed: false,
    repairStepIndex: 0,
    repairStepProgress: 0,
  });
  const problemId = addProblem(world, {
    kind: "machineSymptom",
    payload: { machineId, symptomKey: "grinding" },
    owner: "equipment",
    visibility: "discovered",
    dedupeKey: `machineSymptom:${machineId}:wornBearing`,
    status: "open",
    createdTick: world.state.tick,
    revision: 0,
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId },
  });
  return { machineId, problemId };
}

/** A diagnosed `misfire` on the engine plus its public `machineFault` problem. */
export function addEngineFault(world: World): { machineId: MachineId; problemId: ProblemId } {
  const machineId = machineByPlacement(world, "engine1");
  const machine = world.state.machines[machineId];
  if (machine === undefined) throw new Error("no engine");
  machine.faults.push({
    faultKey: "misfire",
    sinceTick: world.state.tick,
    diagnosed: true,
    repairStepIndex: 0,
    repairStepProgress: 0,
  });
  const problemId = addProblem(world, {
    kind: "machineFault",
    payload: { machineId, faultKey: "misfire" },
    owner: "equipment",
    visibility: "public",
    dedupeKey: `machineFault:${machineId}:misfire`,
    status: "open",
    createdTick: world.state.tick,
    revision: 0,
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId },
  });
  return { machineId, problemId };
}
