/**
 * W1 test fixture (slice 4): a small ship with somewhere to spend a watch off. Six rooms in a row
 * joined by doorless openings: an airlock with the ramp and the gangway post, the lounge (a games
 * table with four seats, a vid screen, the book shelf with three books, the viewport), the gym
 * (an exercise rig and the sparring mat), a bunkroom of four bunks with their lockers, the
 * captain's cabin (bunk, locker, desk) and the bridge with the helm.
 *
 *   x 0123456789ABCDEFGHIJKL   rooms by column: A airlock 0-1, L lounge 2-8, Y gym 9-11,
 *   0 AALLLLLLLYYYQQQQKKKBBB   Q bunkroom 12-15, K captain's cabin 16-18, B bridge 19-21
 *
 * Lounge: games table (4,2)-(5,2) with seats (4,1) (5,1) (4,3) (5,3); vid screen (7,1) watched
 * from (7,0) (8,1) (7,2) (6,1); book shelf (2,0) (2,1) with three books; viewport (7,4) (8,4).
 * Gym: exercise rig (10,0) worked from (10,1); sparring mat (9,3) (10,3). Bunkroom: bunks
 * (12..15,0), berths (12..15,1), lockers (12..15,4). Cabin: bunk (16,0), berth (16,1), locker
 * (18,0), desk (18,3) worked from (17,3). Bridge: helm (21,1), seat (20,1), standby (21,2).
 * Gangway post (1,2), the ramp west of (0,2).
 *
 * Crew, in actor order, with their interests: a1 Mara (captain, piloting 6; stargazing keen,
 * reading; dislikes vids), a2 Noor (pilot, piloting 3; vids keen, stargazing; dislikes board
 * games), a3 Bettina (cook; music keen, cooking; dislikes sparring; her harmonica is in her
 * locker), a4 Jax (pilot, piloting 8; cards keen, vids; dislikes reading), a5 Tomas (engineer;
 * sparring keen, exercise; dislikes debate; neutral on cards), a6 Dane (deckhand; board games
 * keen, music; dislikes cards). The bill: Red = Mara, Noor, Bettina (watch 0), White = Jax,
 * Tomas, Dane (watch 1), on a 600 s day of two watches, so White is off watch at the start.
 * Berths: Mara the cabin, Noor, Bettina, Jax and Tomas the bunks in that order, Dane none. No need
 * moves unless a test sets it (`recreationPerDay` 0 by default). Travel and ports are the freight
 * fixture's: docked at the home port.
 */
import { createDefLookup } from "../../../core/defs";
import { FIXTURE_ACTIVITIES } from "../../../core/fixtures/ship-life";
import { type TestWorld, cmd } from "../../../core/fixtures/test-world";
import { checkInvariants } from "../../../core/invariants";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import { createRngApi } from "../../../core/rng";
import type { Interests } from "../../../core/types/actor";
import type { TileCoord } from "../../../core/types/common";
import type {
  ActivityDef,
  ConfigDef,
  ContentBundle,
  CrewDef,
  ItemDef,
  MachineDef,
  WatchBillDef,
} from "../../../core/types/content";
import type { EventDraft, SimEvent } from "../../../core/types/events";
import type {
  ActivityDefId,
  ActorId,
  CrewDefId,
  DeckDefId,
  ItemDefId,
  MachineDefId,
  ScenarioDefId,
  TopicDefId,
} from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { StepCtx } from "../../../core/types/pipeline";
import { registerPlannerDefaults } from "../../../planner/index";
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
import { registerWork } from "../../work/index";
import { workViolations } from "../../work/invariants";
import { registerRecreation } from "../index";

export const LOUNGE = {
  deck: "deck.lounge.test" as DeckDefId,
  table: "machine.lounge.games_table" as MachineDefId,
  screen: "machine.lounge.vid_screen" as MachineDefId,
  rig: "machine.lounge.exercise_rig" as MachineDefId,
  bunk: "machine.lounge.bunk" as MachineDefId,
  desk: "machine.lounge.desk" as MachineDefId,
  helm: "machine.lounge.helm" as MachineDefId,
  book: "item.lounge.book" as ItemDefId,
  harmonica: "item.lounge.harmonica" as ItemDefId,
  scenario: "scenario.lounge.test" as ScenarioDefId,
  mara: "crew.lounge.mara" as CrewDefId,
  noor: "crew.lounge.noor" as CrewDefId,
  bettina: "crew.lounge.bettina" as CrewDefId,
  jax: "crew.lounge.jax" as CrewDefId,
  tomas: "crew.lounge.tomas" as CrewDefId,
  dane: "crew.lounge.dane" as CrewDefId,
} as const;

export const ACTIVITY = {
  cards: "activity.cards" as ActivityDefId,
  reading: "activity.reading" as ActivityDefId,
  exercise: "activity.exercise" as ActivityDefId,
  music: "activity.music" as ActivityDefId,
  vids: "activity.vids" as ActivityDefId,
  stargazing: "activity.stargazing" as ActivityDefId,
  sparring: "activity.sparring" as ActivityDefId,
  boardGame: "activity.board_game" as ActivityDefId,
} as const;

/** Actor ids, in the scenario's crew order. */
export const MARA = "a1" as ActorId;
export const NOOR = "a2" as ActorId;
export const BETTINA = "a3" as ActorId;
export const JAX = "a4" as ActorId;
export const TOMAS = "a5" as ActorId;
export const DANE = "a6" as ActorId;

export const TABLE_SEATS: readonly TileCoord[] = [
  { x: 4, y: 1 },
  { x: 5, y: 1 },
  { x: 4, y: 3 },
  { x: 5, y: 3 },
];
export const SHELF: readonly TileCoord[] = [
  { x: 2, y: 0 },
  { x: 2, y: 1 },
];
export const VIEWPORT: readonly TileCoord[] = [
  { x: 7, y: 4 },
  { x: 8, y: 4 },
];
export const BETTINA_LOCKER: TileCoord = { x: 13, y: 4 };
export const DESK_SEAT: TileCoord = { x: 17, y: 3 };
export const BUNKROOM_FLOOR: TileCoord = { x: 13, y: 3 };
export const BRIDGE_FLOOR: TileCoord = { x: 19, y: 3 };
export const GYM_FLOOR: TileCoord = { x: 11, y: 2 };

export const LOUNGE_DAY = 600;
export const LOUNGE_WATCH = LOUNGE_DAY / 2;

export const LOUNGE_BILL: WatchBillDef = {
  sections: [
    { key: "red", members: [LOUNGE.mara, LOUNGE.noor, LOUNGE.bettina] },
    { key: "white", members: [LOUNGE.jax, LOUNGE.tomas, LOUNGE.dane] },
  ],
  dayworkers: [],
};

/** The freight fixture's config on a 600 s day of two watches; no need moves by default. */
export function loungeConfig(recreationPerDay = 0): ConfigDef {
  const base = fixtureConfig({ quietTooLongSeconds: 1_000_000 });
  return {
    ...base,
    time: { ...base.time, daySeconds: LOUNGE_DAY, watchesPerDay: 2 },
    needs: {
      ...base.needs,
      hungerPerDay: 0,
      fatiguePerDayAwake: 0,
      fatiguePerDayWorking: 0,
      comfortPerDay: 0,
      socialPerDay: 0,
      recreationPerDay,
    },
    watches: { ...base.watches, dayworkerOnWatches: [0] },
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

const one = (key: string, x: number, y: number) =>
  ({ key, offset: { x, y }, purposes: ["use"], capacity: 1 }) as const;

const MACHINES: Record<MachineDefId, MachineDef> = {
  [LOUNGE.table]: {
    id: LOUNGE.table,
    name: "Games Table",
    tags: ["gamesTable"],
    footprint: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
    interactionPositions: [
      one("seat_1", 0, -1),
      one("seat_2", 1, -1),
      one("seat_3", 0, 1),
      one("seat_4", 1, 1),
    ],
    ...still,
  },
  [LOUNGE.screen]: {
    id: LOUNGE.screen,
    name: "Vid Screen",
    tags: ["vidScreen"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [
      one("north", 0, -1),
      one("east", 1, 0),
      one("south", 0, 1),
      one("west", -1, 0),
    ],
    ...still,
  },
  [LOUNGE.rig]: {
    id: LOUNGE.rig,
    name: "Exercise Rig",
    tags: ["exerciseRig"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [one("station", 0, 1)],
    ...still,
  },
  [LOUNGE.bunk]: {
    id: LOUNGE.bunk,
    name: "Bunk",
    tags: ["bed"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [one("berth", 0, 1)],
    ...still,
  },
  [LOUNGE.desk]: {
    id: LOUNGE.desk,
    name: "Desk",
    tags: ["desk"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [one("seat", -1, 0)],
    ...still,
  },
  [LOUNGE.helm]: {
    id: LOUNGE.helm,
    name: "Helm",
    tags: ["pilotStation"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [
      { key: "seat", offset: { x: -1, y: 0 }, purposes: ["operate", "repair"], capacity: 1 },
      one("standby", 0, 1),
    ],
    ...still,
    operation: { requiresOperator: true, operatorSkill: { skill: "piloting", min: 3 } },
  },
};

const ITEMS: Record<ItemDefId, ItemDef> = {
  [LOUNGE.book]: {
    id: LOUNGE.book,
    name: "Book",
    stacking: "stackable",
    maxStack: 6,
    tags: ["book"],
    toolKinds: [],
    mass: 0.3,
  },
  [LOUNGE.harmonica]: {
    id: LOUNGE.harmonica,
    name: "Harmonica",
    stacking: "unique",
    maxStack: 1,
    tags: ["personal", "instrument"],
    toolKinds: [],
    mass: 0.2,
  },
};

/** The default bundle's other group and solo activities this deck has a venue for. */
export const LOUNGE_ACTIVITIES: readonly ActivityDef[] = [
  ...Object.values(FIXTURE_ACTIVITIES),
  {
    id: ACTIVITY.music,
    label: "playing the harmonica",
    waitingLabel: "tuning up",
    interest: "music",
    venue: [{ compartmentTag: "lounge" }, { compartmentTag: "mess" }],
    participants: { min: 1, max: 1 },
    durationDays: 0.05,
    restores: { recreation: 0.4 },
    outcome: "perform",
    thoughts: { listened: "enjoyedMusic", listenedDislike: "hatedTheNoise" },
    requires: { itemTag: "instrument", own: true },
  },
  {
    id: ACTIVITY.vids,
    label: "watching a vid",
    waitingLabel: "waiting for the vid to start",
    interest: "vids",
    venue: [{ machineTag: "vidScreen" }],
    participants: { min: 1, max: 4 },
    durationDays: 0.12,
    restores: { recreation: 0.4, social: 0.2 },
    outcome: "bond",
    thoughts: { joined: "goodCompany" },
    memories: { together: "goodTime" },
    topics: ["topic.the_vid" as TopicDefId],
  },
  {
    id: ACTIVITY.stargazing,
    label: "stargazing",
    waitingLabel: "watching the stars",
    interest: "stargazing",
    venue: [{ zoneTag: "viewport" }],
    participants: { min: 1, max: 2 },
    durationDays: 0.06,
    restores: { recreation: 0.35, comfort: 0.1 },
    outcome: "bond",
    thoughts: { joined: "goodCompany" },
    memories: { together: "goodTime" },
    transitOnly: true,
  },
  {
    id: ACTIVITY.sparring,
    label: "sparring",
    waitingLabel: "waiting for a sparring partner",
    interest: "sparring",
    venue: [{ zoneTag: "sparringMat" }],
    participants: { min: 2, max: 2 },
    durationDays: 0.04,
    restores: { recreation: 0.4, social: 0.1 },
    fatigueCost: 0.1,
    outcome: "contest",
    thoughts: { win: "wonContest", lose: "lostContest" },
  },
  {
    id: ACTIVITY.boardGame,
    label: "playing a board game",
    waitingLabel: "setting up a board game",
    interest: "boardgames",
    venue: [{ machineTag: "gamesTable" }],
    participants: { min: 2, max: 2 },
    durationDays: 0.08,
    restores: { recreation: 0.4, social: 0.2 },
    outcome: "contest",
    thoughts: { win: "wonContest", lose: "lostContest" },
  },
];

function crewDef(
  id: CrewDefId,
  name: string,
  roleTags: CrewDef["roleTags"],
  skills: CrewDef["skills"],
  interests: Interests,
  startingInventory: CrewDef["startingInventory"] = [],
): CrewDef {
  return {
    id,
    name,
    roleTags,
    skills,
    startingInventory,
    bio: "Lounge fixture crew.",
    voice: "Plain and brief.",
    interests,
    values: { orderFreedom: 0, faithReason: 0, loyaltyAmbition: 0 },
  };
}

const ROW = "AALLLLLLLYYYQQQQKKKBBB";

export interface LoungeContentOptions {
  /** Replace the activity table (default `LOUNGE_ACTIVITIES`). */
  readonly activities?: readonly ActivityDef[];
  /** Replace the watch bill (default `LOUNGE_BILL`). */
  readonly bill?: WatchBillDef;
}

export function loungeContent(
  config: ConfigDef = loungeConfig(),
  options: LoungeContentOptions = {},
): ContentBundle {
  const base = fixtureContent(config);
  const openings = [0, 1, 2, 3, 4].flatMap((y) =>
    [1, 8, 11, 15, 18].map((x) => ({ x, y, side: "e" as const })),
  );
  const crew = [
    crewDef(
      LOUNGE.mara,
      "Mara Osei",
      ["captain"],
      { piloting: 6 },
      {
        likes: ["stargazing", "reading"],
        strong: "stargazing",
        dislikes: ["vids"],
      },
    ),
    crewDef(
      LOUNGE.noor,
      "Noor Haddad",
      ["pilot"],
      { piloting: 3 },
      {
        likes: ["vids", "stargazing"],
        strong: "vids",
        dislikes: ["boardgames"],
      },
    ),
    crewDef(
      LOUNGE.bettina,
      "Bettina Solheim",
      ["cook"],
      { cooking: 8 },
      { likes: ["music", "cooking"], strong: "music", dislikes: ["sparring"] },
      [{ itemDefId: LOUNGE.harmonica, count: 1 }],
    ),
    crewDef(
      LOUNGE.jax,
      "Jax Okonkwo",
      ["pilot"],
      { piloting: 8 },
      {
        likes: ["cards", "vids"],
        strong: "cards",
        dislikes: ["reading"],
      },
    ),
    crewDef(
      LOUNGE.tomas,
      "Tomas Ruiz",
      ["engineer"],
      { engineering: 5 },
      {
        likes: ["sparring", "exercise"],
        strong: "sparring",
        dislikes: ["debate"],
      },
    ),
    crewDef(
      LOUNGE.dane,
      "Dane Whitcross",
      ["deckhand"],
      { cargo: 3 },
      {
        likes: ["boardgames", "music"],
        strong: "boardgames",
        dislikes: ["cards"],
      },
    ),
  ];
  const spawnTiles: TileCoord[] = [
    { x: 3, y: 0 },
    { x: 3, y: 4 },
    { x: 6, y: 3 },
    { x: 6, y: 4 },
    { x: 8, y: 2 },
    { x: 8, y: 3 },
  ];
  const activities = options.activities ?? LOUNGE_ACTIVITIES;
  return {
    ...base,
    decks: {
      [LOUNGE.deck]: {
        id: LOUNGE.deck,
        name: "Lounge test deck",
        width: ROW.length,
        height: 5,
        tiles: [ROW, ROW, ROW, ROW, ROW],
        compartments: [
          { key: "airlock", symbol: "A", name: "Airlock", tags: ["airlock"] },
          { key: "lounge", symbol: "L", name: "Lounge", tags: ["lounge"] },
          { key: "gym", symbol: "Y", name: "Gym", tags: ["gym"] },
          { key: "quarters", symbol: "Q", name: "Bunkroom", tags: ["quarters"] },
          {
            key: "captains_cabin",
            symbol: "K",
            name: "Captain's Cabin",
            tags: ["cabin", "captainsCabin"],
          },
          { key: "bridge", symbol: "B", name: "Bridge", tags: ["bridge"] },
        ],
        doors: [
          {
            key: "ramp",
            edge: { x: 0, y: 2, side: "w" },
            kind: "ramp",
            manualOperationSupported: true,
            initialState: "closed",
          },
        ],
        openings,
        walls: [],
        machines: [
          { key: "table", machineDefId: LOUNGE.table, origin: { x: 4, y: 2 }, rotation: 0 },
          { key: "screen", machineDefId: LOUNGE.screen, origin: { x: 7, y: 1 }, rotation: 0 },
          { key: "rig", machineDefId: LOUNGE.rig, origin: { x: 10, y: 0 }, rotation: 0 },
          ...[12, 13, 14, 15].map((x, i) => ({
            key: `bunk${i + 1}`,
            machineDefId: LOUNGE.bunk,
            origin: { x, y: 0 },
            rotation: 0 as const,
          })),
          { key: "capt_bunk", machineDefId: LOUNGE.bunk, origin: { x: 16, y: 0 }, rotation: 0 },
          { key: "capt_desk", machineDefId: LOUNGE.desk, origin: { x: 18, y: 3 }, rotation: 0 },
          { key: "helm", machineDefId: LOUNGE.helm, origin: { x: 21, y: 1 }, rotation: 0 },
        ],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [
          { key: "gangway", name: "Gangway Post", tags: ["gangway"], tiles: [{ x: 1, y: 2 }] },
          {
            key: "stowage",
            name: "Cargo stowage",
            tags: ["cargoStowage"],
            tiles: [{ x: 1, y: 4 }],
          },
          { key: "book_shelf", name: "Book shelf", tags: ["bookShelf"], tiles: [...SHELF] },
          { key: "viewport", name: "Viewport", tags: ["viewport"], tiles: [...VIEWPORT] },
          {
            key: "sparring_mat",
            name: "Sparring mat",
            tags: ["sparringMat"],
            tiles: [
              { x: 9, y: 3 },
              { x: 10, y: 3 },
            ],
          },
          ...[12, 13, 14, 15].map((x, i) => ({
            key: `locker_bunk${i + 1}`,
            name: "Locker",
            tags: ["locker"],
            tiles: [{ x, y: 4 }],
            machineKey: `bunk${i + 1}`,
          })),
          {
            key: "locker_capt",
            name: "Locker",
            tags: ["locker"],
            tiles: [{ x: 18, y: 0 }],
            machineKey: "capt_bunk",
          },
        ],
        docking: {
          cargoRampDoorKey: "ramp",
          personnelRampDoorKey: "ramp",
          cargoTransferTiles: [{ x: 0, y: 2 }],
          personnelTransferTiles: [{ x: 0, y: 2 }],
        },
        hull: { class: "test_hull", sizeClass: "S" },
        spawnPoints: spawnTiles.map((tile, i) => ({ key: `lounge${i}`, tile, tags: ["crew"] })),
      },
    },
    machines: MACHINES,
    items: { ...base.items, ...ITEMS },
    activities: Object.fromEntries(activities.map((def) => [def.id, def])),
    crew: Object.fromEntries(crew.map((def) => [def.id, def])),
    scenarios: {
      [LOUNGE.scenario]: {
        id: LOUNGE.scenario,
        name: "Lounge",
        deckId: LOUNGE.deck,
        startPortId: PORTS.a,
        crew: crew.map((def) => def.id),
        startingMoney: 500,
        startingItems: [{ itemDefId: LOUNGE.book, count: 3, zoneKey: "book_shelf" }],
        initialFaults: [],
        watchBill: options.bill ?? LOUNGE_BILL,
      },
    },
    hash: "lounge-deck-v1",
  };
}

export interface LoungeWorldOptions extends LoungeContentOptions {
  readonly config?: ConfigDef;
  readonly seed?: number;
  /** Register the recreation system (default true; false shows a world without it). */
  readonly recreation?: boolean;
}

/** Spatial, travel, needs, the watch, recreation, work and the planner. */
export function loungeWorld(options: LoungeWorldOptions = {}): TestWorld {
  const config = options.config ?? loungeConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerWatch(registry);
  if (options.recreation !== false) registerRecreation(registry);
  registerWork(registry, { derivations: { ...travelTaskDerivations } });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    LOUNGE.scenario,
    options.seed ?? 5,
    loungeContent(config, options),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

// ---------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------

/** Ticks in `seconds` on this world's clock. */
export const secondsOf = (world: World, seconds: number): number =>
  Math.round(seconds * world.config.values.time.tickRate);

/** Teleport a stationary actor to a tile centre (setup only). */
export function placeInLounge(world: World, actorId: ActorId, tile: TileCoord): void {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: LOUNGE.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}

/** Set one need for the named actors (all of them when none are named). */
export function setNeed(
  world: World,
  need: "recreation" | "comfort" | "social" | "hunger" | "fatigue",
  value: number,
  ids: readonly ActorId[] = Object.keys(world.state.actors) as ActorId[],
): void {
  for (const id of ids) {
    const actor = world.state.actors[id];
    if (actor === undefined) throw new Error(`no actor ${id}`);
    actor.needs[need] = value;
  }
}

function violations(world: World): string[] {
  return [
    ...checkInvariants(world.state),
    ...spatialViolations(world),
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
  until: (world: World, events: readonly SimEvent[]) => boolean,
  check?: (world: World, events: readonly SimEvent[]) => void,
): SimEvent[] {
  const { kernel, world } = fixture;
  const events: SimEvent[] = [];
  for (let i = 0; i <= secondsOf(world, maxSeconds); i++) {
    if (until(world, events)) return events;
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

/** Run for `seconds` more, collecting events. */
export function runFor(
  fixture: TestWorld,
  seconds: number,
  check?: (world: World, events: readonly SimEvent[]) => void,
): SimEvent[] {
  const end = fixture.world.state.tick + secondsOf(fixture.world, seconds);
  return runUntil(fixture, seconds + 1, (w) => w.state.tick >= end, check);
}

export const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** The actor's tile now (throws off deck). */
export function tileNow(world: World, actorId: ActorId): TileCoord {
  const location = world.state.actors[actorId]?.location;
  if (location?.kind !== "onDeck") throw new Error(`${actorId} is not on deck`);
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

/** A step context over the world at its next tick, collecting what is emitted (unit tests). */
export function loungeStepCtx(world: World): { ctx: StepCtx; drafts: EventDraft[] } {
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

/** Set a course to the next port; with no nav terminal aboard it counts as plotted (D78). */
export function setCourseAway(fixture: TestWorld): void {
  fixture.kernel.enqueueCommand(
    fixture.world,
    cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
  );
}

/** Give `actorId` a mood of about `value` with one long-lived thought (setup only). */
export function setMood(world: World, actorId: ActorId, value: number): void {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.thoughts = [{ key: "doubleWatch", value, expiresAtTick: world.state.tick + 1_000_000 }];
  actor.mood = value;
}
