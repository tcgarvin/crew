/**
 * Dirt test fixture (D82): the W4a crew deck with the dockside ramps, a quay that loads boots
 * (`grime` 0.8) and settles dust (`airborneDust` 1), a cleaning locker in the corridor with the
 * mop, and a crew of four by role. The dirt system runs; no equipment, travel or watch systems.
 *
 *   x 0123456789AB
 *   0 AbbbBBBBCCCC    A = quarters, B = galley and mess, C = engineering
 *   1 A...BrBBC.PC    H = corridor and cargo hold (tagged both)
 *   2 AAAABBBBCwCC    P = pump (10,1); E = engine (11,3)
 *   3 AAAABBBBCCeE    L = cleaning locker (11,5), the mop's home
 *   4 AdAABbBBCCcC    r (cargo ramp) under (2,6), p (personnel ramp) under (9,6)
 *   5 HHHHHHHHHHHL
 *   6 HHrHHHHHHpHH
 *
 * Crew (actor ids in scenario order): Mara a1 captain, Jon a2 deckhand, Bettina a3 cook (all
 * `alpha`, on duty for the first 300 s of the 600 s day), Priya a4 engineer (`beta`, off duty
 * then; `alpha` in the `engineerOnDuty` scenario).
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../../core/fixtures/tiny-content";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { TileCoord } from "../../../core/types/common";
import type { ConfigDef, ContentBundle, DockDef, ItemDef } from "../../../core/types/content";
import type { ActorId, CrewDefId, ItemDefId, ScenarioDefId } from "../../../core/types/ids";
import { registerPlannerDefaults } from "../../../planner/index";
import { registerNeeds } from "../../needs/index";
import { attachDock } from "../../spatial/dock";
import { DECK12 } from "../../spatial/fixtures/deck-12x8";
import { DOCK, QUAY, withRamps } from "../../spatial/fixtures/dock";
import { registerSpatial } from "../../spatial/index";
import { ALL_DERIVATIONS, crewConfig, crewContent } from "../../work/fixtures/crew-deck";
import { registerWork } from "../../work/index";
import { registerDirt } from "../index";

export const DIRT_DECK = {
  deck: DECK12.deck,
  scenario: "scenario.test.dirt" as ScenarioDefId,
  engineerOnDuty: "scenario.test.dirtEngineer" as ScenarioDefId,
  mop: "item.test.mop" as ItemDefId,
  bettina: "crew.test.bettina" as CrewDefId,
  priya: "crew.test.priya" as CrewDefId,
} as const;

export const MARA = "a1" as ActorId;
export const JON = "a2" as ActorId;
export const BETTINA = "a3" as ActorId;
export const PRIYA = "a4" as ActorId;

export const LOCKER_TILE: TileCoord = { x: 11, y: 5 };
/** The top of the cargo ramp (deck frame) and its landing on the quay. */
export const RAMP_TOP: TileCoord = { x: 2, y: 6 };
export const RAMP_LANDING: TileCoord = DOCK.cargoLanding;

const mopDef: ItemDef = {
  id: DIRT_DECK.mop,
  name: "Mop",
  stacking: "unique",
  maxStack: 1,
  tags: ["tool"],
  toolKinds: ["mop"],
  mass: 1,
};

export interface DirtDockOptions {
  readonly grime?: number;
  readonly airborneDust?: number;
}

export function dirtContent(
  config: ConfigDef = crewConfig(),
  dock: DirtDockOptions = {},
): ContentBundle {
  const base = crewContent(config);
  const deck = base.decks[DECK12.deck];
  const mara = base.crew[TINY.mara];
  const jon = base.crew[DECK12.jon];
  const crew2 = Object.values(base.scenarios)[0];
  if (deck === undefined || mara === undefined || jon === undefined || crew2 === undefined) {
    throw new Error("crew deck fixture changed");
  }
  const quay: DockDef = {
    ...QUAY,
    grime: dock.grime ?? 0.8,
    airborneDust: dock.airborneDust ?? 1,
  };
  const ramped = withRamps(deck);
  const crew = [TINY.mara, DECK12.jon, DIRT_DECK.bettina, DIRT_DECK.priya];
  const scenario = (id: ScenarioDefId, priyaSection: "alpha" | "beta") => ({
    ...crew2,
    id,
    name: "Dirt",
    crew,
    startingItems: [
      ...crew2.startingItems,
      { itemDefId: DIRT_DECK.mop, count: 1, zoneKey: "cleaning_locker" },
    ],
    watchBill: {
      sections: [
        {
          key: "alpha",
          members: [
            TINY.mara,
            DECK12.jon,
            DIRT_DECK.bettina,
            ...(priyaSection === "alpha" ? [DIRT_DECK.priya] : []),
          ],
        },
        { key: "beta", members: priyaSection === "beta" ? [DIRT_DECK.priya] : [] },
      ],
      dayworkers: [],
    },
  });
  return {
    ...base,
    decks: {
      [DECK12.deck]: {
        ...ramped,
        zones: [
          ...ramped.zones,
          {
            key: "cleaning_locker",
            name: "Cleaning locker",
            tags: ["cleaningLocker"],
            tiles: [LOCKER_TILE],
          },
        ],
      },
    },
    docks: { [DOCK.id]: quay },
    items: { ...base.items, [DIRT_DECK.mop]: mopDef },
    crew: {
      ...base.crew,
      [TINY.mara]: { ...mara, roleTags: ["captain"] },
      [DECK12.jon]: { ...jon, roleTags: ["deckhand"] },
      [DIRT_DECK.bettina]: {
        ...jon,
        id: DIRT_DECK.bettina,
        name: "Bettina Solheim",
        roleTags: ["cook"],
        skills: { cooking: 6 },
      },
      [DIRT_DECK.priya]: {
        ...jon,
        id: DIRT_DECK.priya,
        name: "Priya Kessler",
        roleTags: ["engineer"],
        skills: { engineering: 5 },
      },
    },
    scenarios: {
      [DIRT_DECK.scenario]: scenario(DIRT_DECK.scenario, "beta"),
      [DIRT_DECK.engineerOnDuty]: scenario(DIRT_DECK.engineerOnDuty, "alpha"),
    },
    hash: "dirt-deck-v1",
  };
}

export interface DirtWorldOptions {
  readonly config?: ConfigDef;
  readonly scenario?: ScenarioDefId;
  readonly dock?: DirtDockOptions;
  /** Register only spatial and dirt (no needs, work or planner): nobody acts on their own. */
  readonly bare?: boolean;
  readonly seed?: number;
}

/** Spatial, dirt, needs, work (every derivation) and the planner on the dirt deck. */
export function dirtWorld(options: DirtWorldOptions = {}): TestWorld {
  const config = options.config ?? crewConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerDirt(registry);
  if (options.bare !== true) {
    registerNeeds(registry);
    registerWork(registry, { derivations: ALL_DERIVATIONS });
    registerPlannerDefaults(registry);
  }
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    options.scenario ?? DIRT_DECK.scenario,
    options.seed ?? 11,
    dirtContent(config, options.dock),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** Bring the quay alongside (ramps still closed). */
export function bringQuayAlongside(test: TestWorld): void {
  attachDock(test.world, { dockId: DOCK.id, deckId: DECK12.deck });
}

/** Teleport a stationary actor to a tile centre (setup only; dock tiles are deck-frame). */
export function placeAt(test: TestWorld, actorId: ActorId, tile: TileCoord): void {
  const actor = test.world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: DECK12.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}

/** The deck's dirt row. */
export function cellsOf(test: TestWorld): number[] {
  const cells = test.world.state.dirt.cells[DECK12.deck];
  if (cells === undefined) throw new Error("no dirt row");
  return cells;
}

/** A tile's cell. */
export function cellAt(test: TestWorld, tile: TileCoord): number {
  return cellsOf(test)[tile.y * 12 + tile.x] ?? Number.NaN;
}

/** Set every floor cell of a room's tiles listed to `value`. */
export function soil(test: TestWorld, tiles: readonly TileCoord[], value: number): void {
  const cells = cellsOf(test);
  for (const t of tiles) cells[t.y * 12 + t.x] = value;
}
