/**
 * A small self-contained `ContentBundle` for W5 (power/equipment) tests: one generator, one
 * battery, one coolant-tagged pump, one engine (with a fault and a maintenance schedule) and one
 * life-support consumer, all on one power domain. Independent of `core/fixtures/tiny-content.ts`
 * so these tests do not depend on — or risk perturbing — the shared kernel fixture.
 */
import {
  FIXTURE_ACTIVITIES,
  FIXTURE_THOUGHTS,
  FIXTURE_TOPICS,
} from "../../../core/fixtures/ship-life";
import { tinyConfig, tinyEffectiveConfig } from "../../../core/fixtures/tiny-content";
import type { ConfigDef, ContentBundle, MachineFailureDef } from "../../../core/types/content";
import type {
  CrewDefId,
  DeckDefId,
  ItemDefId,
  MachineDefId,
  PortDefId,
  ScenarioDefId,
} from "../../../core/types/ids";
import type { EffectiveConfig } from "../../../core/types/kernel";

export const W5 = {
  deck: "deck.w5.main" as DeckDefId,
  generator: "machine.w5.generator" as MachineDefId,
  battery: "machine.w5.battery" as MachineDefId,
  pump: "machine.w5.pump" as MachineDefId,
  engine: "machine.w5.engine" as MachineDefId,
  lifeSupport: "machine.w5.lifesupport" as MachineDefId,
  wrench: "item.w5.wrench" as ItemDefId,
  bearing: "item.w5.bearing" as ItemDefId,
  tech: "crew.w5.tech" as CrewDefId,
  port: "port.w5.dock" as PortDefId,
  scenario: "scenario.w5" as ScenarioDefId,
} as const;

export interface W5Overrides {
  readonly engineFailure?: MachineFailureDef;
  readonly generatorSupplyKw?: number;
}

export function w5Content(
  config: ConfigDef = tinyConfig(),
  overrides: W5Overrides = {},
): ContentBundle {
  const engineFailure: MachineFailureDef = overrides.engineFailure ?? {
    baseHazardPerSecond: 0,
    heatFactor: 2,
    wearPerSecond: 0.0005,
  };
  return {
    decks: {
      [W5.deck]: {
        id: W5.deck,
        name: "W5 test deck",
        width: 6,
        height: 3,
        tiles: ["AAAAAA", "AAAAAA", "AAAAAA"],
        compartments: [{ key: "eng", symbol: "A", name: "Engineering", tags: ["engineering"] }],
        doors: [],
        openings: [],
        walls: [],
        machines: [
          {
            key: "gen1",
            machineDefId: W5.generator,
            origin: { x: 0, y: 0 },
            rotation: 0,
            powerDomain: "main",
          },
          {
            key: "bat1",
            machineDefId: W5.battery,
            origin: { x: 1, y: 0 },
            rotation: 0,
            powerDomain: "main",
          },
          {
            key: "pump1",
            machineDefId: W5.pump,
            origin: { x: 2, y: 0 },
            rotation: 0,
            powerDomain: "main",
          },
          {
            key: "engine1",
            machineDefId: W5.engine,
            origin: { x: 3, y: 0 },
            rotation: 0,
            powerDomain: "main",
          },
          {
            key: "life1",
            machineDefId: W5.lifeSupport,
            origin: { x: 4, y: 0 },
            rotation: 0,
            powerDomain: "main",
          },
        ],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [{ key: "stores", name: "Stores", tags: ["cargoStowage"], tiles: [{ x: 0, y: 2 }] }],
        docking: {
          cargoRampDoorKey: "none",
          personnelRampDoorKey: "none",
          cargoTransferTiles: [{ x: 0, y: 0 }],
          personnelTransferTiles: [{ x: 0, y: 0 }],
        },
        hull: { class: "test_hull", sizeClass: "S" },
        spawnPoints: [{ key: "bunk", tile: { x: 0, y: 1 }, tags: ["crew"] }],
      },
    },
    machines: {
      [W5.generator]: {
        id: W5.generator,
        name: "Fusion generator",
        tags: ["generator"],
        footprint: [{ x: 0, y: 0 }],
        interactionPositions: [
          { key: "front", offset: { x: -1, y: 0 }, purposes: ["operate"], capacity: 1 },
        ],
        power: { role: "generator", supplyKw: overrides.generatorSupplyKw ?? 10 },
        heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
        operation: { requiresOperator: false },
        failure: { baseHazardPerSecond: 0, heatFactor: 1, wearPerSecond: 0 },
        faults: [],
        components: [],
      },
      [W5.battery]: {
        id: W5.battery,
        name: "Battery bank",
        tags: ["battery"],
        footprint: [{ x: 0, y: 0 }],
        interactionPositions: [
          { key: "front", offset: { x: -1, y: 0 }, purposes: ["operate"], capacity: 1 },
        ],
        power: { role: "battery", capacityKj: 20, maxChargeKw: 5, maxDischargeKw: 5 },
        heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
        operation: { requiresOperator: false },
        failure: { baseHazardPerSecond: 0, heatFactor: 1, wearPerSecond: 0 },
        faults: [],
        components: [],
      },
      [W5.pump]: {
        id: W5.pump,
        name: "Coolant pump",
        tags: ["cooling"],
        footprint: [{ x: 0, y: 0 }],
        interactionPositions: [
          { key: "front", offset: { x: -1, y: 0 }, purposes: ["repair", "operate"], capacity: 1 },
        ],
        power: { role: "consumer", drawKw: 1, priority: "criticalCooling", partialPower: "derate" },
        heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
        operation: { requiresOperator: false },
        failure: { baseHazardPerSecond: 0, heatFactor: 1, wearPerSecond: 0 },
        faults: [],
        components: [],
      },
      [W5.engine]: {
        id: W5.engine,
        name: "Main engine",
        tags: ["engine"],
        footprint: [{ x: 0, y: 0 }],
        interactionPositions: [
          { key: "front", offset: { x: -1, y: 0 }, purposes: ["repair", "operate"], capacity: 1 },
        ],
        power: { role: "consumer", drawKw: 6, priority: "propulsion", partialPower: "derate" },
        // Chosen so that, at full power, the engine cools with its coolant pump running (net
        // -0.01/s) but overheats without it (net +0.014/s at 1/5th cooling) — see equipment.test.ts.
        heat: { risePerSecond: 0.02, coolPerSecond: 0.03, derateAbove: 0.5 },
        operation: { requiresOperator: false },
        failure: engineFailure,
        faults: [
          {
            key: "wornBearing",
            name: "Worn bearing",
            weight: 1,
            effect: { kind: "derate", outputFactor: 0.5 },
            symptom: { key: "vibration", channel: "audible" },
            repair: {
              steps: [
                {
                  key: "replace",
                  action: "repair",
                  workSeconds: 10,
                  skill: { skill: "engineering", min: 1 },
                  tools: ["wrench"],
                  consumes: [{ itemDefId: W5.bearing, count: 1 }],
                  at: "repair",
                },
              ],
            },
          },
        ],
        components: [],
        maintenance: {
          intervalSeconds: 100,
          inspect: {
            key: "check",
            action: "inspect",
            workSeconds: 5,
            tools: [],
            consumes: [],
            at: "repair",
          },
          conditionRestored: 0.3,
        },
      },
      [W5.lifeSupport]: {
        id: W5.lifeSupport,
        name: "Life support",
        tags: ["lifeSupport"],
        footprint: [{ x: 0, y: 0 }],
        interactionPositions: [
          { key: "front", offset: { x: -1, y: 0 }, purposes: ["operate"], capacity: 1 },
        ],
        power: { role: "consumer", drawKw: 2, priority: "lifeSupport", partialPower: "off" },
        heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
        operation: { requiresOperator: false },
        failure: { baseHazardPerSecond: 0, heatFactor: 1, wearPerSecond: 0 },
        faults: [],
        components: [],
      },
    },
    items: {
      [W5.wrench]: {
        id: W5.wrench,
        name: "Wrench",
        stacking: "unique",
        maxStack: 1,
        tags: ["tool"],
        toolKinds: ["wrench"],
        mass: 1,
      },
      [W5.bearing]: {
        id: W5.bearing,
        name: "Spare bearing",
        stacking: "stackable",
        maxStack: 5,
        tags: ["spare"],
        toolKinds: [],
        mass: 0.5,
      },
    },
    crew: {
      [W5.tech]: {
        id: W5.tech,
        name: "Tess Okafor",
        roleTags: ["engineer"],
        skills: { engineering: 5 },
        startingInventory: [
          { itemDefId: W5.wrench, count: 1 },
          { itemDefId: W5.bearing, count: 2 },
        ],
        bio: "Keeps the reactor humming.",
        voice: "Plain and brief.",
      },
    },
    traits: {},
    ports: {
      [W5.port]: {
        id: W5.port,
        name: "W5 Dock",
        setting: "station",
        description: "A dock.",
        character: "A dock.",
        castSeed: [],
        externalStores: [{ key: "warehouse", name: "Warehouse", kind: "warehouse" }],
        market: [],
        jobTemplates: [],
        routes: [],
      },
    },
    scenarios: {
      [W5.scenario]: {
        id: W5.scenario,
        name: "W5",
        deckId: W5.deck,
        startPortId: W5.port,
        crew: [W5.tech],
        startingMoney: 0,
        startingItems: [],
        initialFaults: [],
      },
    },
    thoughts: FIXTURE_THOUGHTS,
    activities: FIXTURE_ACTIVITIES,
    topics: FIXTURE_TOPICS,
    config,
    hash: "w5-content-v1",
  };
}

export function w5EffectiveConfig(config: ConfigDef = tinyConfig()): EffectiveConfig {
  return tinyEffectiveConfig(config);
}
