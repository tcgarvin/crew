/**
 * W2 test fixture (§gangway-watch-and-rounds, §course-plotting): the W4a crew deck widened by a
 * four-column bridge, so an officer's round has every stop and a course has a nav terminal to be
 * plotted at.
 *
 *   x 0123456789ABCDEF
 *   0 AAAABBBBCCCCDDDN   N = nav terminal (15,0), its seat (14,0)
 *   1 AAAABBBBC.PCDDDh   h = helm (15,1): seat (14,1), standby (15,2)
 *   2 AAAABBBBCCCC.cDD   c = captain's chair (13,2), its seat (12,2)
 *   3 AAAABBBBCCeEDDDD   P = pump (10,1), repair (9,1); E = engine (11,3), service (10,3)
 *   4 AdAABbBBCCcCDdDD   doors on the south edge of (1,4) (5,4) (10,4) (13,4)
 *   5 HHHHHHHHHHHHHHHH
 *   6 HHHHHHHHHHHHHHHH
 *
 * A = quarters, B = galley and mess, C = engineering, D = bridge, H = corridor and cargo hold.
 * Mara (a1) is the captain, piloting 6; Jon (a2) the engineer, piloting 0. Both stand `alpha`,
 * the first of the day's two 300 s watches (`crewConfig`).
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../../core/fixtures/tiny-content";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { ConfigDef, ContentBundle, MachineDef } from "../../../core/types/content";
import type { MachineDefId, ScenarioDefId } from "../../../core/types/ids";
import { registerPlannerDefaults } from "../../../planner/index";
import { registerNeeds } from "../../needs/index";
import { DECK12 } from "../../spatial/fixtures/deck-12x8";
import { registerSpatial } from "../../spatial/index";
import { registerTravel } from "../../travel/index";
import { ALL_DERIVATIONS, crewConfig, crewContent } from "../../work/fixtures/crew-deck";
import { registerWork } from "../../work/index";
import { registerWatch } from "../index";

export const ROUNDS_DECK = {
  scenario: "scenario.test.rounds" as ScenarioDefId,
  helm: "machine.test.helm" as MachineDefId,
  nav: "machine.test.nav" as MachineDefId,
  chair: "machine.test.chair" as MachineDefId,
} as const;

/** Where the round stops on this deck (`systems/watch/rounds.ts` picks room centres). */
export const ROUNDS_TILES = {
  helmSeat: { x: 14, y: 1 },
  helmStandby: { x: 15, y: 2 },
  navSeat: { x: 14, y: 0 },
  chairSeat: { x: 12, y: 2 },
  pumpRepair: { x: 9, y: 1 },
  engineService: { x: 10, y: 3 },
} as const;

const station: Omit<MachineDef, "id" | "name" | "tags" | "interactionPositions"> = {
  footprint: [{ x: 0, y: 0 }],
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
};

const helmDef: MachineDef = {
  ...station,
  id: ROUNDS_DECK.helm,
  name: "Helm",
  tags: ["pilotStation"],
  interactionPositions: [
    { key: "seat", offset: { x: -1, y: 0 }, purposes: ["operate", "repair"], capacity: 1 },
    { key: "standby", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 },
  ],
  operation: { requiresOperator: true, operatorSkill: { skill: "piloting", min: 3 } },
};

const navDef: MachineDef = {
  ...station,
  id: ROUNDS_DECK.nav,
  name: "Nav Terminal",
  tags: ["navStation"],
  interactionPositions: [
    { key: "seat", offset: { x: -1, y: 0 }, purposes: ["operate"], capacity: 1 },
  ],
  // §course-plotting: a chart fault blocks the terminal; never drawn (no hazard), set by a test.
  faults: [
    {
      key: "chart_fault",
      name: "Corrupted chart store",
      weight: 1,
      effect: { kind: "inoperable" },
      symptom: { key: "chart_checksum_error", channel: "sensor" },
      repair: {
        steps: [
          {
            key: "reload_charts",
            action: "repair",
            workSeconds: 5,
            tools: [],
            consumes: [],
            at: "operate",
          },
        ],
      },
    },
  ],
};

const chairDef: MachineDef = {
  ...station,
  id: ROUNDS_DECK.chair,
  name: "Captain's Chair",
  tags: ["chair"],
  interactionPositions: [{ key: "seat", offset: { x: -1, y: 0 }, purposes: ["use"], capacity: 1 }],
};

export function roundsContent(config: ConfigDef = crewConfig()): ContentBundle {
  const base = crewContent(config);
  const deck = base.decks[DECK12.deck];
  const mara = base.crew[TINY.mara];
  const jon = base.crew[DECK12.jon];
  const crew2 = Object.values(base.scenarios)[0];
  if (deck === undefined || mara === undefined || jon === undefined || crew2 === undefined) {
    throw new Error("crew deck fixture changed");
  }
  const widen = (row: string, y: number) => row + (y < 5 ? "DDDD" : y < 7 ? "HHHH" : "    ");
  return {
    ...base,
    decks: {
      [DECK12.deck]: {
        ...deck,
        width: 16,
        tiles: deck.tiles.map(widen),
        compartments: [
          ...deck.compartments,
          { key: "bridge", symbol: "D", name: "Bridge", tags: ["bridge"] },
        ],
        doors: [
          ...deck.doors,
          {
            key: "doorD",
            edge: { x: 13, y: 4, side: "s" },
            kind: "interior",
            manualOperationSupported: true,
            initialState: "open",
          },
        ],
        machines: [
          ...deck.machines,
          { key: "helm1", machineDefId: ROUNDS_DECK.helm, origin: { x: 15, y: 1 }, rotation: 0 },
          { key: "nav1", machineDefId: ROUNDS_DECK.nav, origin: { x: 15, y: 0 }, rotation: 0 },
          { key: "chair1", machineDefId: ROUNDS_DECK.chair, origin: { x: 13, y: 2 }, rotation: 0 },
        ],
      },
    },
    machines: {
      ...base.machines,
      [ROUNDS_DECK.helm]: helmDef,
      [ROUNDS_DECK.nav]: navDef,
      [ROUNDS_DECK.chair]: chairDef,
    },
    crew: {
      ...base.crew,
      [TINY.mara]: { ...mara, roleTags: ["captain"] },
      [DECK12.jon]: { ...jon, roleTags: ["engineer"] },
    },
    scenarios: {
      ...base.scenarios,
      [ROUNDS_DECK.scenario]: { ...crew2, id: ROUNDS_DECK.scenario, name: "Rounds" },
    },
    hash: "rounds-deck-v1",
  };
}

export interface RoundsWorldOptions {
  readonly config?: ConfigDef;
  readonly seed?: number;
  /** Travel's systems and commands (`setCourse`, the course plot). */
  readonly travel?: boolean;
}

/**
 * Spatial, needs, work (all derivations), the planner, and optionally travel. No equipment:
 * machines never fail on their own, so a test's symptoms are the ones it adds.
 */
export function roundsWorld(options: RoundsWorldOptions = {}): TestWorld {
  const config = options.config ?? crewConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  if (options.travel === true) registerTravel(registry);
  registerNeeds(registry);
  // §gangway-watch-and-rounds: with travel the helm must be stood (its watch post and seat), so the
  // watch runs too.
  if (options.travel === true) registerWatch(registry);
  registerWork(registry, { derivations: ALL_DERIVATIONS });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    ROUNDS_DECK.scenario,
    options.seed ?? 11,
    roundsContent(config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}
