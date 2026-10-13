import { createDefLookup } from "../../../core/defs";
/**
 * W1 test fixture (§meal-problem): a small ship with a galley, for the meal rhythm. Five rooms in a
 * row joined by doorless openings: an airlock with the ramp and the gangway post, the galley
 * (stove, serving counter, pantry), the mess (one four-seat table and a ration stack), a bunkroom,
 * and the bridge with the helm (seat and standby).
 *
 *   x 0123456789ABCDEFG
 *   0 LLLSGGMssMMbbbBBB    S = stove (3,0), worked from u (3,1); c = serving counter (4,1)
 *   1 LgLucGMTTMMeeeB@H    T = mess table (7,1)-(8,1), s = its seats (7,0) (8,0) (7,2) (8,2)
 *   2 LLLGGGMssMMbbQBBv    b = five bunks, e = berths (11,1) (12,1) (13,1) (11,3) (12,3)
 *   3 LoLGPPMMMfReeQBBB    H = helm (16,1): @ = seat (15,1), v = standby (16,2)
 *
 * g = gangway post (1,1), the ramp west of (0,1); P = pantry (4,3) (5,3), six crates of
 * provisions; R = ten ration packs (10,3); f = clear mess floor (9,3); o = cargo stowage (1,3).
 *
 * Crew, in actor order: a1 Bettina (cook, cooking 8), a2 Noor (pilot, piloting 3), a3 Mara
 * (captain, piloting 6), a4 Jax (pilot, piloting 8), a5 Tomas (engineer, cooking 1). The bill:
 * Red = Noor, Mara (watch 0); White = Jax, Tomas (watch 1); Bettina a dayworker on watch 0, so
 * her sleep watch is watch 1. A 600 s day of two 300 s watches; hunger rises a unit a day and
 * nothing else moves unless a test sets it. Travel and ports are the freight fixture's.
 */
import { FIXTURE_GALLEY } from "../../../core/fixtures/ship-life";
import { type TestWorld, cmd } from "../../../core/fixtures/test-world";
import { allocateId } from "../../../core/ids";
import { checkInvariants } from "../../../core/invariants";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import { createRngApi } from "../../../core/rng";
import type { PhysicalLocation, TileCoord } from "../../../core/types/common";
import type {
  ConfigDef,
  ContentBundle,
  CrewDef,
  ItemDef,
  MachineDef,
  MealQuality,
  WatchBillDef,
} from "../../../core/types/content";
import type { EventDraft, SimEvent } from "../../../core/types/events";
import type {
  ActorId,
  CrewDefId,
  DeckDefId,
  ItemDefId,
  MachineDefId,
  ScenarioDefId,
} from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { StepCtx } from "../../../core/types/pipeline";
import type { StackItem } from "../../../core/types/ship";
import { registerPlannerDefaults } from "../../../planner/index";
import { registerCommerce } from "../../commerce/index";
import { commerceTaskDerivations } from "../../commerce/tasks";
import { dirtViolations } from "../../dirt/invariants";
import { registerNeeds } from "../../needs/index";
import { needsViolations } from "../../needs/invariants";
import { registerSpatial } from "../../spatial/index";
import { spatialViolations } from "../../spatial/invariants";
import {
  PORTS,
  fixtureConfig,
  fixtureContent,
  fixtureEffectiveConfig,
} from "../../travel/fixtures";
import { registerTravel } from "../../travel/index";
import { travelTaskDerivations } from "../../travel/tasks";
import { registerWatch } from "../../watch/index";
import { writeFact } from "../../work/facts";
import { registerWork } from "../../work/index";
import { workViolations } from "../../work/invariants";
import { registerGalley } from "../index";
import { galleyTaskDerivations } from "../tasks";

export const GALLEY = {
  deck: "deck.galley.test" as DeckDefId,
  stove: "machine.galley.stove" as MachineDefId,
  table: "machine.galley.table" as MachineDefId,
  bunk: "machine.galley.bunk" as MachineDefId,
  helm: "machine.galley.helm" as MachineDefId,
  provisions: "item.galley.provisions" as ItemDefId,
  meal: "item.galley.hot_meal" as ItemDefId,
  rations: "item.galley.rations" as ItemDefId,
  scenario: "scenario.galley.test" as ScenarioDefId,
  bettina: "crew.galley.bettina" as CrewDefId,
  noor: "crew.galley.noor" as CrewDefId,
  mara: "crew.galley.mara" as CrewDefId,
  jax: "crew.galley.jax" as CrewDefId,
  tomas: "crew.galley.tomas" as CrewDefId,
} as const;

/** Actor ids, in the scenario's crew order. */
export const BETTINA = "a1" as ActorId;
export const NOOR = "a2" as ActorId;
export const MARA = "a3" as ActorId;
export const JAX = "a4" as ActorId;
export const TOMAS = "a5" as ActorId;

export const STOVE_USE: TileCoord = { x: 3, y: 1 };
export const COUNTER: TileCoord = { x: 4, y: 1 };
export const SEATS: readonly TileCoord[] = [
  { x: 7, y: 0 },
  { x: 8, y: 0 },
  { x: 7, y: 2 },
  { x: 8, y: 2 },
];
export const BERTHS: readonly TileCoord[] = [
  { x: 11, y: 1 },
  { x: 12, y: 1 },
  { x: 13, y: 1 },
  { x: 11, y: 3 },
  { x: 12, y: 3 },
];
export const HELM_SEAT: TileCoord = { x: 15, y: 1 };
export const STANDBY: TileCoord = { x: 16, y: 2 };
export const GANGWAY: TileCoord = { x: 1, y: 1 };
export const RATIONS_TILE: TileCoord = { x: 10, y: 3 };
/** A tile in the mess clear of the table, its seats and the rations. */
export const MESS_FLOOR: TileCoord = { x: 9, y: 3 };

export const GALLEY_DAY = 600;
export const GALLEY_WATCH = GALLEY_DAY / 2;

/** The bill this fixture is written against. */
export const GALLEY_BILL: WatchBillDef = {
  sections: [
    { key: "red", members: [GALLEY.noor, GALLEY.mara] },
    { key: "white", members: [GALLEY.jax, GALLEY.tomas] },
  ],
  dayworkers: [GALLEY.bettina],
};

/** The freight fixture's config on a 600 s day of two watches; hunger moves, nothing else. */
export function galleyConfig(galley: Partial<ConfigDef["galley"]> = {}): ConfigDef {
  const base = fixtureConfig({ quietTooLongSeconds: 1_000_000 });
  return {
    ...base,
    time: { ...base.time, daySeconds: GALLEY_DAY, watchesPerDay: 2 },
    needs: {
      ...base.needs,
      hungerPerDay: 1,
      fatiguePerDayAwake: 0,
      fatiguePerDayWorking: 0,
      comfortPerDay: 0,
      socialPerDay: 0,
      mealDays: 6 / GALLEY_DAY,
    },
    watches: { ...base.watches, dayworkerOnWatches: [0] },
    galley: { ...FIXTURE_GALLEY, cookSeconds: 10, ...galley },
  };
}

const still = {
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
} as const;

const MACHINES: Record<MachineDefId, MachineDef> = {
  [GALLEY.stove]: {
    id: GALLEY.stove,
    name: "Galley Stove",
    tags: ["stove"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [
      { key: "front", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 },
    ],
    ...still,
    // §stove-down: a burner fault blocks the stove; never drawn (no hazard), set by a test.
    faults: [
      {
        key: "burner_fault",
        name: "Burned-out burner",
        weight: 1,
        effect: { kind: "inoperable" },
        symptom: { key: "cold_burner", channel: "visual" },
        repair: {
          steps: [
            {
              key: "replace_element",
              action: "repair",
              workSeconds: 5,
              tools: [],
              consumes: [],
              at: "use",
            },
          ],
        },
      },
    ],
  },
  [GALLEY.table]: {
    id: GALLEY.table,
    name: "Mess Table",
    tags: ["messTable"],
    footprint: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
    interactionPositions: [
      { key: "seat_1", offset: { x: 0, y: -1 }, purposes: ["use"], capacity: 1 },
      { key: "seat_2", offset: { x: 1, y: -1 }, purposes: ["use"], capacity: 1 },
      { key: "seat_3", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 },
      { key: "seat_4", offset: { x: 1, y: 1 }, purposes: ["use"], capacity: 1 },
    ],
    ...still,
  },
  [GALLEY.bunk]: {
    id: GALLEY.bunk,
    name: "Bunk",
    tags: ["bed"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [
      { key: "berth", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 },
    ],
    ...still,
  },
  [GALLEY.helm]: {
    id: GALLEY.helm,
    name: "Helm",
    tags: ["pilotStation"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [
      { key: "seat", offset: { x: -1, y: 0 }, purposes: ["operate", "repair"], capacity: 1 },
      { key: "standby", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 },
    ],
    ...still,
    operation: { requiresOperator: true, operatorSkill: { skill: "piloting", min: 3 } },
  },
};

const stackable = (
  id: ItemDefId,
  name: string,
  tags: ItemDef["tags"],
  mass: number,
  nutrition?: number,
): ItemDef => ({
  id,
  name,
  stacking: "stackable",
  maxStack: 20,
  tags,
  toolKinds: [],
  mass,
  ...(nutrition === undefined ? {} : { nutrition }),
});

const ITEMS: Record<ItemDefId, ItemDef> = {
  [GALLEY.provisions]: stackable(GALLEY.provisions, "Provisions", ["provisions"], 2),
  [GALLEY.meal]: stackable(GALLEY.meal, "Hot Meal", ["food", "consumable", "meal"], 0.5, 0.4),
  [GALLEY.rations]: stackable(GALLEY.rations, "Ration Pack", ["food", "consumable"], 0.4, 0.25),
};

function crewDef(
  id: CrewDefId,
  name: string,
  roleTags: CrewDef["roleTags"],
  skills: CrewDef["skills"],
): CrewDef {
  return {
    id,
    name,
    roleTags,
    skills,
    startingInventory: [],
    bio: "Galley fixture crew.",
    voice: "Plain and brief.",
  };
}

const ROWS = ["LLLGGGMMMMMQQQBBB", "LLLGGGMMMMMQQQBBB", "LLLGGGMMMMMQQQBBB", "LLLGGGMMMMMQQQBBB"];

export interface GalleyContentOptions {
  /** Provisions the home port's market sells (no line at all when undefined). */
  readonly provisionsStock?: number;
  /** Crates in the pantry at the start (default 6). */
  readonly crates?: number;
}

export function galleyContent(
  config: ConfigDef = galleyConfig(),
  options: GalleyContentOptions = {},
): ContentBundle {
  const base = fixtureContent(config);
  const home = base.ports[PORTS.a];
  if (home === undefined) throw new Error("freight fixture changed: no home port");
  const openings = [0, 1, 2, 3].flatMap((y) =>
    [2, 5, 10, 13].map((x) => ({ x, y, side: "e" as const })),
  );
  const crew = [
    crewDef(GALLEY.bettina, "Bettina Solheim", ["cook"], { cooking: 8, piloting: 1 }),
    crewDef(GALLEY.noor, "Noor Haddad", ["pilot"], { piloting: 3 }),
    crewDef(GALLEY.mara, "Mara Osei", ["captain"], { piloting: 6 }),
    crewDef(GALLEY.jax, "Jax Okonkwo", ["pilot"], { piloting: 8 }),
    crewDef(GALLEY.tomas, "Tomas Ruiz", ["engineer", "deckhand"], { cooking: 1, piloting: 1 }),
  ];
  const spawnTiles: TileCoord[] = [
    { x: 6, y: 0 },
    { x: 6, y: 1 },
    { x: 6, y: 2 },
    { x: 6, y: 3 },
    { x: 9, y: 0 },
    { x: 9, y: 1 },
    { x: 9, y: 2 },
    { x: 10, y: 0 },
  ];
  return {
    ...base,
    decks: {
      [GALLEY.deck]: {
        id: GALLEY.deck,
        name: "Galley test deck",
        width: 17,
        height: 4,
        tiles: ROWS,
        compartments: [
          { key: "airlock", symbol: "L", name: "Airlock", tags: ["airlock"] },
          { key: "galley", symbol: "G", name: "Galley", tags: ["galley"] },
          { key: "mess", symbol: "M", name: "Mess", tags: ["mess"] },
          { key: "quarters", symbol: "Q", name: "Bunkroom", tags: ["quarters"] },
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
          { key: "stove", machineDefId: GALLEY.stove, origin: { x: 3, y: 0 }, rotation: 0 },
          { key: "table", machineDefId: GALLEY.table, origin: { x: 7, y: 1 }, rotation: 0 },
          ...[
            { x: 11, y: 0 },
            { x: 12, y: 0 },
            { x: 13, y: 0 },
            { x: 11, y: 2 },
            { x: 12, y: 2 },
          ].map((origin, i) => ({
            key: `bunk${i + 1}`,
            machineDefId: GALLEY.bunk,
            origin,
            rotation: 0 as const,
          })),
          { key: "helm", machineDefId: GALLEY.helm, origin: { x: 16, y: 1 }, rotation: 0 },
        ],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [
          { key: "gangway", name: "Gangway Post", tags: ["gangway"], tiles: [GANGWAY] },
          { key: "serving", name: "Serving counter", tags: ["serving"], tiles: [COUNTER] },
          {
            key: "pantry",
            name: "Pantry",
            tags: ["pantry"],
            tiles: [
              { x: 4, y: 3 },
              { x: 5, y: 3 },
            ],
          },
          { key: "rations", name: "Ration locker", tags: [], tiles: [RATIONS_TILE] },
          {
            key: "stowage",
            name: "Cargo stowage",
            tags: ["cargoStowage"],
            tiles: [{ x: 1, y: 3 }],
          },
        ],
        docking: {
          cargoRampDoorKey: "ramp",
          personnelRampDoorKey: "ramp",
          cargoTransferTiles: [{ x: 0, y: 1 }],
          personnelTransferTiles: [{ x: 0, y: 1 }],
        },
        hull: { class: "test_hull", sizeClass: "S", max: 100 },
        spawnPoints: spawnTiles.map((tile, i) => ({ key: `mess${i}`, tile, tags: ["crew"] })),
      },
    },
    machines: MACHINES,
    items: { ...base.items, ...ITEMS },
    ports: {
      ...base.ports,
      [PORTS.a]: {
        ...home,
        market:
          options.provisionsStock === undefined
            ? home.market
            : [
                ...home.market,
                { itemDefId: GALLEY.provisions, count: options.provisionsStock, price: 5 },
              ],
      },
    },
    crew: Object.fromEntries(crew.map((def) => [def.id, def])),
    scenarios: {
      [GALLEY.scenario]: {
        id: GALLEY.scenario,
        name: "Galley",
        deckId: GALLEY.deck,
        startPortId: PORTS.a,
        crew: crew.map((def) => def.id),
        startingMoney: 500,
        startingItems: [
          ...(options.crates === 0
            ? []
            : [{ itemDefId: GALLEY.provisions, count: options.crates ?? 6, zoneKey: "pantry" }]),
          { itemDefId: GALLEY.rations, count: 10, zoneKey: "rations" },
        ],
        initialFaults: [],
        watchBill: GALLEY_BILL,
      },
    },
    hash: "galley-deck-v1",
  };
}

export interface GalleyWorldOptions extends GalleyContentOptions {
  readonly config?: ConfigDef;
  readonly seed?: number;
  /** Register commerce too (the market, `reserveLow` and its purchase). */
  readonly commerce?: boolean;
}

/** Spatial, travel, (commerce,) needs, the watch, the galley, work and the planner. */
export function galleyWorld(options: GalleyWorldOptions = {}): TestWorld {
  const config = options.config ?? galleyConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  if (options.commerce === true) registerCommerce(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerWork(registry, {
    derivations: {
      ...travelTaskDerivations,
      ...commerceTaskDerivations,
      ...galleyTaskDerivations,
    },
  });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    GALLEY.scenario,
    options.seed ?? 5,
    galleyContent(config, options),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** Teleport a stationary actor to a tile centre (setup only). */
export function placeOnGalleyDeck(world: World, actorId: ActorId, tile: TileCoord): void {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: GALLEY.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}

// ---------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------

/** Ticks in `seconds` on this world's clock. */
export const secondsOf = (world: World, seconds: number): number =>
  Math.round(seconds * world.config.values.time.tickRate);

/** Seconds since tick 0 on this world's clock. */
export const nowSeconds = (world: World): number =>
  world.state.tick / world.config.values.time.tickRate;

/** Every invariant the galley's tests hold the world to after each tick. */
function violations(world: World): string[] {
  return [
    ...checkInvariants(world.state),
    ...spatialViolations(world),
    ...dirtViolations(world),
    ...workViolations(world),
    ...needsViolations(world),
  ];
}

/**
 * Advance one tick at a time (acknowledging hooks, checking invariants) until `until` holds,
 * collecting the events; `check` sees every tick. Throws if `maxSeconds` runs out first.
 */
export function runUntil(
  fixture: TestWorld,
  maxSeconds: number,
  until: (world: World) => boolean,
  check?: (world: World, events: readonly SimEvent[]) => void,
): SimEvent[] {
  const { kernel, world } = fixture;
  const events: SimEvent[] = [];
  for (let i = 0; i <= secondsOf(world, maxSeconds); i++) {
    if (until(world)) return events;
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    const hookId = world.state.narrator.pendingHook?.id;
    if (result.halt.kind === "hook" && hookId !== undefined) {
      kernel.enqueueCommand(
        world,
        cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
      );
    }
    const broken = violations(world);
    if (broken.length > 0) throw new Error(`tick ${world.state.tick}: ${broken.join("; ")}`);
    check?.(world, result.events);
  }
  throw new Error(`condition not met within ${maxSeconds} s (tick ${world.state.tick})`);
}

/** Run until the clock reads `seconds` (from tick 0). */
export function runToSecond(
  fixture: TestWorld,
  seconds: number,
  check?: (world: World, events: readonly SimEvent[]) => void,
): SimEvent[] {
  const world = fixture.world;
  const end = secondsOf(world, seconds);
  const left = (end - world.state.tick) / world.config.values.time.tickRate;
  return runUntil(fixture, Math.max(0, left) + 1, (w) => w.state.tick >= end, check);
}

export const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** The actor's tile now (throws off deck). */
export function tileNow(world: World, actorId: ActorId): TileCoord {
  const location = world.state.actors[actorId]?.location;
  if (location?.kind !== "onDeck") throw new Error(`${actorId} is not on deck`);
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

/** A tile centre on the galley deck, as a location. */
export const onGalleyDeck = (tile: TileCoord): PhysicalLocation => ({
  kind: "onDeck",
  deckId: GALLEY.deck,
  x: tile.x + 0.5,
  y: tile.y + 0.5,
});

/** A stack of served meals (or rations, with no quality) at `location`, known to everyone. */
export function addServing(
  world: World,
  location: PhysicalLocation,
  quality: MealQuality | undefined,
  count = 1,
): StackItem {
  const id = allocateId(world.state, "item");
  const item: StackItem = {
    id,
    defId: quality === undefined ? GALLEY.rations : GALLEY.meal,
    stacking: "stack",
    count,
    reserved: 0,
    location,
    ...(quality === undefined
      ? {}
      : { meal: { quality, spoilsAtTick: world.state.tick + 10_000, cookId: BETTINA } }),
  };
  world.state.items[id] = item;
  world.caches.dirty.inventory = true;
  for (const actor of Object.values(world.state.actors)) {
    writeFact(
      actor,
      id,
      "itemLocation",
      { location },
      {
        tick: world.state.tick,
        sourceId: BETTINA,
        evidence: "report",
        certainty: "reported",
      },
    );
  }
  return item;
}

/** A step context over the world at its next tick, collecting what is emitted (unit tests). */
export function galleyStepCtx(world: World): { ctx: StepCtx; drafts: EventDraft[] } {
  const drafts: EventDraft[] = [];
  const ctx = {
    state: world.state,
    caches: world.caches,
    content: world.content,
    defs: createDefLookup(world.content, world.state),
    config: world.config.values,
    rng: createRngApi(world.state),
    tick: world.state.tick + 1,
    elapsedTicks: 1,
    dirty: world.caches.dirty,
    emit: (draft: EventDraft) => {
      drafts.push(draft);
    },
  } satisfies StepCtx;
  return { ctx, drafts };
}

/**
 * Set a course to the next port; with no nav terminal aboard it counts as plotted
 * (§course-plotting).
 */
export function setCourseAway(fixture: TestWorld): void {
  fixture.kernel.enqueueCommand(
    fixture.world,
    cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
  );
}
