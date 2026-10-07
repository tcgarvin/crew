/**
 * W1 test fixture (D92): a small ship for the asteroid field. Four rooms in a row joined by
 * doorless openings: an airlock with the ramp and the gangway post, a hold (the biggest room, for
 * the uniform-hit share), engineering with the engine, and the bridge with the helm and the nav
 * terminal. Every tile is hull (80 of them).
 *
 *   x 0123456789ABCDEF
 *   0 LLLHHHHHHEEEBNBB     N = nav terminal (13,0), operated from (13,1)
 *   1 LLLHHHHHHEEEBBBB     H = helm (15,2): @ = seat (14,2), v = standby (15,3)
 *   2 rgLHHHHHHEXEBB@H     X = engine (10,2); r = ramp, west of (0,2); g = gangway post (1,2)
 *   3 LLLHHHHHHEEEBBBv
 *   4 LLLHHHHHHEEEBBBB
 *
 * Crew, in actor order: a1 Jax (pilot, piloting set by the test, 9 by default), a2 Mara
 * (captain, 6), a3 Priya (engineer, 1), a4 Bettina (cook, 1). The bill: Red = Jax, Mara (watch 0,
 * so Jax stands the helm); White = Priya; Blue = Bettina. A 3600 s day of three 1200 s watches,
 * needs still. Ports are the freight fixture's with Alpha–Beta stretched to `LEG_DISTANCE` (1000 s
 * at nominal speed 5) and the rest further; the approach lead is 1 s.
 *
 * No power or equipment system runs; a stand-in sets each engine's output to 0 while it is
 * blocked (`isMachineBlocked`) and 1 otherwise, so a knocked-out engine stops the ship the way
 * the real systems would. Damage response is the gate's stub (`damageMachine` only lowers
 * integrity), called by the field directly.
 */
import { FIXTURE_FIELD } from "../../../core/fixtures/ship-life";
import { type TestWorld, cmd } from "../../../core/fixtures/test-world";
import { checkInvariants } from "../../../core/invariants";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { CommandOfKind } from "../../../core/types/commands";
import type { TileCoord } from "../../../core/types/common";
import type {
  ConfigDef,
  ContentBundle,
  CrewDef,
  MachineDef,
  PortDef,
  WatchBillDef,
} from "../../../core/types/content";
import type { SimEvent } from "../../../core/types/events";
import type {
  ActorId,
  CompartmentId,
  CrewDefId,
  DeckDefId,
  MachineDefId,
  PortDefId,
  ScenarioDefId,
} from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { System } from "../../../core/types/pipeline";
import type { Machine } from "../../../core/types/ship";
import type { ActiveField } from "../../../core/types/state";
import { compartmentByKey } from "../../../core/world";
import { registerPlannerDefaults } from "../../../planner/index";
import { isMachineBlocked } from "../../equipment/equipment";
import { registerNeeds } from "../../needs/index";
import { registerSpatial } from "../../spatial/index";
import { spatialViolations } from "../../spatial/invariants";
import {
  FIX,
  PORTS,
  advanceThroughHooks,
  fixtureConfig,
  fixtureContent,
  fixtureEffectiveConfig,
} from "../../travel/fixtures";
import { registerTravel } from "../../travel/index";
import { travelViolations } from "../../travel/invariants";
import { travelTaskDerivations } from "../../travel/tasks";
import { whoHasTheHelm } from "../../watch/helm";
import { registerWatch } from "../../watch/index";
import { registerWork } from "../../work/index";
import { registerField } from "../index";
import { fieldViolations } from "../invariants";

export const FIELD = {
  deck: "deck.field.test" as DeckDefId,
  helm: "machine.field.helm" as MachineDefId,
  nav: "machine.field.nav" as MachineDefId,
  scenario: "scenario.field.test" as ScenarioDefId,
  jax: "crew.field.jax" as CrewDefId,
  mara: "crew.field.mara" as CrewDefId,
  priya: "crew.field.priya" as CrewDefId,
  bettina: "crew.field.bettina" as CrewDefId,
} as const;

export const JAX = "a1" as ActorId;
export const MARA = "a2" as ActorId;
export const PRIYA = "a3" as ActorId;
export const BETTINA = "a4" as ActorId;

export const ENGINE_TILE: TileCoord = { x: 10, y: 2 };
export const HELM_TILE: TileCoord = { x: 15, y: 2 };
export const FIELD_DAY = 3600;
/** Alpha–Beta, stretched so every field fits the leg. */
export const LEG_DISTANCE = 5000;

const ROWS = Array.from({ length: 5 }, () => "LLLHHHHHHEEEBBBB");

export interface FieldWorldOptions {
  /** Jax's piloting (the stander on watch 0). Default 9. */
  readonly piloting?: number;
  /** Register the watch, so someone takes the helm. Default true; false leaves it empty. */
  readonly watch?: boolean;
  readonly seed?: number;
  readonly field?: Partial<ConfigDef["field"]>;
}

/** The freight fixture's config on a 3600 s day of three watches, needs still. */
export function fieldConfig(field: Partial<ConfigDef["field"]> = {}): ConfigDef {
  const base = fixtureConfig({ quietTooLongSeconds: 1_000_000 });
  return {
    ...base,
    time: { ...base.time, daySeconds: FIELD_DAY, watchesPerDay: 3 },
    needs: {
      ...base.needs,
      hungerPerDay: 0,
      fatiguePerDayAwake: 0,
      fatiguePerDayWorking: 0,
      comfortPerDay: 0,
      socialPerDay: 0,
      mealDays: 4 / FIELD_DAY,
    },
    watches: {
      ...base.watches,
      dayworkerOnWatches: [0, 1],
      reliefMaxDays: 120 / FIELD_DAY,
      plotCourseSeconds: 2,
    },
    narrator: { ...base.narrator, approachHookLeadSeconds: 1 },
    field: { ...FIXTURE_FIELD, ...field },
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
  id: FIELD.helm,
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
  id: FIELD.nav,
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
    bio: "Field fixture crew.",
    voice: "Plain and brief.",
  };
}

/**
 * The freight fixture's ports with every route ten times `LEG_DISTANCE` but Alpha–Beta, which is
 * `LEG_DISTANCE`: so a course for Beta is that one leg, not a shorter way round through Gamma.
 */
function stretchedPorts(ports: ContentBundle["ports"]): ContentBundle["ports"] {
  const isLeg = (from: PortDefId, to: PortDefId) =>
    (from === PORTS.a && to === PORTS.b) || (from === PORTS.b && to === PORTS.a);
  const stretch = (from: PortDefId, port: PortDef): PortDef => ({
    ...port,
    routes: port.routes.map((route) => ({
      ...route,
      distance: isLeg(from, route.toPortId) ? LEG_DISTANCE : 10 * LEG_DISTANCE,
    })),
  });
  return Object.fromEntries(
    Object.entries(ports).map(([id, port]) => [id, stretch(id as PortDefId, port)]),
  );
}

export function fieldContent(config: ConfigDef, piloting: number): ContentBundle {
  const base = fixtureContent(config);
  const engine = base.machines[FIX.engine];
  if (engine === undefined) throw new Error("freight fixture lost its engine");
  const openings = [0, 1, 2, 3, 4].flatMap((y) => [
    { x: 2, y, side: "e" as const },
    { x: 8, y, side: "e" as const },
    { x: 11, y, side: "e" as const },
  ]);
  const crew = [
    crewDef(FIELD.jax, "Jax Okonkwo", ["pilot"], piloting),
    crewDef(FIELD.mara, "Mara Osei", ["captain"], 6),
    crewDef(FIELD.priya, "Priya Kessler", ["engineer"], 1),
    crewDef(FIELD.bettina, "Bettina Solheim", ["cook"], 1),
  ];
  const bill: WatchBillDef = {
    sections: [
      { key: "red", members: [FIELD.jax, FIELD.mara] },
      { key: "white", members: [FIELD.priya] },
      { key: "blue", members: [FIELD.bettina] },
    ],
    dayworkers: [],
  };
  return {
    ...base,
    decks: {
      [FIELD.deck]: {
        id: FIELD.deck,
        name: "Field test deck",
        width: 16,
        height: 5,
        tiles: ROWS,
        compartments: [
          { key: "airlock", symbol: "L", name: "Airlock", tags: ["airlock"] },
          { key: "hold", symbol: "H", name: "Hold", tags: ["cargo", "quarters"] },
          { key: "engineering", symbol: "E", name: "Engineering", tags: ["engineering"] },
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
          { key: "helm", machineDefId: FIELD.helm, origin: HELM_TILE, rotation: 0 },
          { key: "nav", machineDefId: FIELD.nav, origin: { x: 13, y: 0 }, rotation: 0 },
          { key: "engine1", machineDefId: FIX.engine, origin: ENGINE_TILE, rotation: 0 },
        ],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [
          { key: "gangway", name: "Gangway Post", tags: ["gangway"], tiles: [{ x: 1, y: 2 }] },
          {
            key: "stowage",
            name: "Cargo stowage",
            tags: ["cargoStowage"],
            tiles: [{ x: 7, y: 4 }],
          },
        ],
        docking: {
          cargoRampDoorKey: "ramp",
          personnelRampDoorKey: "ramp",
          cargoTransferTiles: [{ x: 0, y: 2 }],
          personnelTransferTiles: [{ x: 0, y: 2 }],
        },
        hull: { class: "test_hull", sizeClass: "S", max: 100 },
        spawnPoints: [4, 5, 6].flatMap((x) => [
          { key: `hold${x}a`, tile: { x, y: 1 }, tags: ["crew"] },
          { key: `hold${x}b`, tile: { x, y: 3 }, tags: ["crew"] },
        ]),
      },
    },
    machines: { [FIELD.helm]: helmDef, [FIELD.nav]: navDef, [FIX.engine]: engine },
    crew: Object.fromEntries(crew.map((def) => [def.id, def])),
    ports: stretchedPorts(base.ports),
    scenarios: {
      [FIELD.scenario]: {
        id: FIELD.scenario,
        name: "Field",
        deckId: FIELD.deck,
        startPortId: PORTS.a,
        crew: crew.map((def) => def.id),
        startingMoney: 0,
        startingItems: [],
        initialFaults: [],
        watchBill: bill,
      },
    },
    hash: "field-deck-v1",
  };
}

/** Stands in for power and equipment: an engine runs at 1 unless it is blocked, then 0. */
const engineOutputStandIn: System = {
  name: "fixture.engineOutput",
  phase: "equipment",
  run(ctx) {
    for (const machine of Object.values(ctx.state.machines)) {
      const def = ctx.content.machines[machine.defId];
      if (def === undefined || !def.tags.includes("engine")) continue;
      machine.output = isMachineBlocked(machine, def, ctx.config.equipment) ? 0 : 1;
    }
  },
};

/** Spatial, the engine stand-in, travel, the field, needs, the watch, work and the planner. */
export function fieldWorld(options: FieldWorldOptions = {}): TestWorld {
  const config = fieldConfig(options.field);
  const registry = createRegistry();
  registerSpatial(registry);
  registry.registerSystem(engineOutputStandIn);
  registerTravel(registry);
  registerField(registry);
  registerNeeds(registry);
  if (options.watch !== false) registerWatch(registry);
  registerWork(registry, { derivations: travelTaskDerivations });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    FIELD.scenario,
    options.seed ?? 7,
    fieldContent(config, options.piloting ?? 9),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

export const secondsOf = (world: World, seconds: number): number =>
  Math.round(seconds * world.config.values.time.tickRate);

/**
 * Advance one tick at a time (acknowledging hooks) until `until` holds, collecting the events.
 * Stops early on a lost ship; throws if `maxSeconds` runs out first.
 */
export function runUntil(
  test: TestWorld,
  maxSeconds: number,
  until: (world: World) => boolean,
): SimEvent[] {
  const events: SimEvent[] = [];
  const { world, kernel } = test;
  for (let i = 0; i < secondsOf(world, maxSeconds); i++) {
    if (until(world)) return events;
    const result = advanceThroughHooks(kernel, world, 1);
    events.push(...result.events);
    if (result.halt.kind === "lost") break;
  }
  if (until(world)) return events;
  throw new Error(`condition not met within ${maxSeconds} s (tick ${world.state.tick})`);
}

/** Advance `seconds`, collecting the events. */
export function runFor(test: TestWorld, seconds: number): SimEvent[] {
  const end = test.world.state.tick + secondsOf(test.world, seconds);
  return runUntil(test, seconds + 1, (w) => w.state.tick >= end);
}

/** Set a course for Beta and plot it by hand (the nav terminal's story is not the field's). */
export function setPlottedCourse(test: TestWorld): void {
  test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
  );
  advanceThroughHooks(test.kernel, test.world, 1);
  const travel = test.world.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId === undefined) {
    throw new Error("no course planned in port");
  }
  travel.coursePlotted = true;
}

/**
 * Put the ship in transit to Beta by hand, at the start of the leg, and (with the watch) run
 * until the stander has the helm.
 */
export function underWay(test: TestWorld, watch = true): void {
  const { world } = test;
  world.state.travel = {
    stage: "transit",
    fromPortId: PORTS.a,
    toPortId: PORTS.b,
    stageProgress: 0,
    routeProgress: 0,
    routeDistance: LEG_DISTANCE,
    drifting: false,
    stageStartedTick: world.state.tick,
  };
  if (watch) runUntil(test, 120, (w) => whoHasTheHelm(w.state, w.content) !== undefined);
}

export type FieldPayload = CommandOfKind<"scheduleField">["payload"];

/** Schedule a field (as the scenario) and apply it; returns the field. */
export function scheduleField(test: TestWorld, payload: FieldPayload): ActiveField {
  const result = test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "scenario", kind: "scheduleField", payload }),
  );
  if (result.status !== "accepted") {
    throw new Error(`scheduleField refused: ${JSON.stringify(result)}`);
  }
  advanceThroughHooks(test.kernel, test.world, 1);
  const field = test.world.state.field;
  if (field === undefined) throw new Error("scheduleField left no field");
  return field;
}

/** The world's field, which the test expects to be there. */
export function fieldOf(world: World): ActiveField {
  const field = world.state.field;
  if (field === undefined) throw new Error("no field");
  return field;
}

export function engineOf(world: World): Machine {
  const engine = Object.values(world.state.machines).find((m) => m.defId === FIX.engine);
  if (engine === undefined) throw new Error("no engine");
  return engine;
}

export function compartment(world: World, key: string): CompartmentId {
  const id = compartmentByKey(world.state, key);
  if (id === undefined) throw new Error(`no compartment ${key}`);
  return id;
}

export type EventOf<T extends SimEvent["type"]> = Extract<SimEvent, { type: T }>;

export const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is EventOf<T> => e.type === type);

/** Every invariant the field's world holds: core, spatial, travel and the field's own. */
export function fieldWorldViolations(world: World): string[] {
  return [
    ...checkInvariants(world.state),
    ...spatialViolations(world),
    ...travelViolations(world),
    ...fieldViolations(world),
  ];
}
