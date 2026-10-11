/**
 * A tiny, self-contained `ContentBundle` for kernel tests: one 6×4 deck with two compartments
 * joined by a door, one crew member carrying rations, one machine, one loose wrench, and three
 * ports in a line (dock - far - beyond), so `beyond` is two hops from the start.
 * Independent of `packages/content` so kernel tests do not depend on authored data.
 */
import type { ConfigDef, ContentBundle } from "../types/content";
import type {
  CrewDefId,
  DeckDefId,
  ItemDefId,
  MachineDefId,
  PortDefId,
  ScenarioDefId,
} from "../types/ids";
import type { EffectiveConfig } from "../types/kernel";
import {
  FIXTURE_ACTIVITIES,
  FIXTURE_BODIES,
  FIXTURE_CABINS,
  FIXTURE_DAMAGE,
  FIXTURE_DIRT,
  FIXTURE_EXPEDITION,
  FIXTURE_FIELD,
  FIXTURE_GALLEY,
  FIXTURE_HAZARDS,
  FIXTURE_INTERCOM,
  FIXTURE_MOOD,
  FIXTURE_RECREATION,
  FIXTURE_SOCIAL,
  FIXTURE_THOUGHTS,
  FIXTURE_TOPICS,
  fixtureWatches,
} from "./ship-life";

export const TINY = {
  deck: "deck.tiny.main" as DeckDefId,
  pump: "machine.tiny.pump" as MachineDefId,
  wrench: "item.tiny.wrench" as ItemDefId,
  rations: "item.tiny.rations" as ItemDefId,
  crate: "item.tiny.crate" as ItemDefId,
  mara: "crew.tiny.mara" as CrewDefId,
  port: "port.tiny.dock" as PortDefId,
  port2: "port.tiny.far" as PortDefId,
  /** Two hops from `port`, via `port2` (30 + 40). */
  port3: "port.tiny.beyond" as PortDefId,
  scenario: "scenario.tiny" as ScenarioDefId,
} as const;

/**
 * The fixture's default ship's day (§the-ships-day): 600 s of two watches, so the scenario's one
 * section (`alpha`) stands `[0, 300)` of every 600 s, the duty window the tests were written
 * against (§sections-and-dayworkers), and dayworkers keep the same hours.
 */
export const TINY_DAY = 600;

export interface TinyConfigOptions {
  /** A fixture convenience in seconds, stored as `narrator.quietTooLongDays`. */
  readonly quietTooLongSeconds?: number;
  /** Ship's day length; the day knobs below keep their durations in seconds whatever it is. */
  readonly daySeconds?: number;
  readonly watchesPerDay?: number;
}

/**
 * Day knobs are written as `seconds / day` and rates as `perSecond * day`, so the values the tests
 * were written against stay visible and the conversion is exact for any `daySeconds`.
 */
export function tinyConfig(options: TinyConfigOptions = {}): ConfigDef {
  const day = options.daySeconds ?? TINY_DAY;
  return {
    time: { tickRate: 20, daySeconds: day, watchesPerDay: options.watchesPerDay ?? 2 },
    movement: {
      walkSpeed: 2,
      passDelaySeconds: 0.5,
      blockedRerouteSeconds: 2,
      fatigueSpeedFloor: 0.5,
      loadSpeedPerKg: 0.01,
      loadSpeedFloor: 0.5,
    },
    doors: {
      openSeconds: 1,
      closeSeconds: 1,
      autoCloseAfterSeconds: 3,
      manualOpenSeconds: 4,
      rampOpenSeconds: 2,
    },
    needs: {
      hungerPerDay: 0.001 * day,
      fatiguePerDayAwake: 0.001 * day,
      fatiguePerDayWorking: 0.002 * day,
      fatigueRecoveryPerDayAsleep: 0.01 * day,
      comfortPerDay: 0.001 * day,
      comfortRecoveryPerDayResting: 0.01 * day,
      socialPerDay: 0.001 * day,
      socialRecoveryPerDayChatting: 0.01 * day,
      recreationPerDay: 0.001 * day,
      seekThreshold: 0.5,
      mealDays: 10 / day,
      sleepDays: 60 / day,
      wakeBelow: 0.1,
      bedtimeAbove: 0.3,
      initialRange: {
        hunger: { min: 0, max: 0 },
        fatigue: { min: 0, max: 0 },
        comfort: { min: 0, max: 0 },
        social: { min: 0, max: 0 },
        recreation: { min: 0, max: 0 },
      },
    },
    work: {
      reconsiderEveryTicks: 10,
      switchCooldownSeconds: 2,
      claimLeaseSeconds: 10,
      timeBucketSeconds: 5,
      retryBackoffSeconds: 5,
      skillGainPerDay: 0.001 * day,
      workSpeedPerSkillLevel: 0.1,
    },
    urgency: {
      needEssentialAbove: 0.7,
      needSurvivalAbove: 0.9,
      heatContainmentAbove: 0.8,
      heatSurvivalAbove: 0.95,
      routineAgingDays: 60 / day,
      cleaningAgingDays: 60 / day,
    },
    equipment: {
      hazardScale: 1,
      overheatDamagePerSecond: 0.01,
      maintenanceConditionBelow: 0.3,
      maintenanceEssentialBelow: 0.15,
      integrityDerateBelow: 0.5,
      integrityInoperableBelow: 0.15,
    },
    power: { priorityOrder: ["lifeSupport", "criticalCooling", "propulsion", "domestic", "cargo"] },
    travel: {
      prepareDepartureSeconds: 5,
      undockSeconds: 3,
      departSeconds: 3,
      approachSeconds: 3,
      dockSeconds: 3,
      nominalSpeed: 1,
      staffEstimateSeconds: 0,
      departureMinOutput: 0.5,
      // §limping: no limp unless a test turns it on.
      limpSpeedFraction: 0,
      recallAboardSeconds: 60,
      localShuffleSeconds: 8,
      dockHandGiveUpSeconds: 30,
      talkSeconds: 3,
      gateVisitSeconds: 4,
      cardDeliveryGiveUpSeconds: 45,
    },
    commerce: {
      priceBands: {
        general: { min: 1, max: 3 },
        fragile: { min: 2, max: 5 },
        perishable: { min: 2, max: 4 },
        hazardous: { min: 3, max: 8 },
        passenger: { min: 2, max: 4 },
        errand: { min: 3, max: 6 },
      },
      jobOfferTtlDays: 120 / day,
      dockingFee: 0,
      haulEstimateSeconds: 5,
      passage: {
        ashoreDaysMin: 3 / day,
        ashoreDaysMax: 3 / day,
        overdueDays: 10 / day,
      },
      // §reserve-kinds: off unless a test turns them on.
      sparesReserve: 0,
      foodReserve: { lowBelowDays: 0, restockToDays: 0 },
      market: {
        priceTiers: { cheap: 0.6, fair: 1, dear: 1.6 },
        maxStockPerCommand: 4,
        defaultPrice: 100,
        buySeconds: 3,
      },
      reofferDays: 60 / day,
      maxCratesPerJob: 6,
    },
    narrator: {
      quietTooLongDays: (options.quietTooLongSeconds ?? 600) / day,
      approachHookLeadSeconds: 5,
      maxSpawnsPerCommand: 3,
      maxFaultWindowSeconds: 60,
      spawnBudget: 3,
      faultBudget: 2,
      budgetRefillDays: 600 / day,
      hookOnEvents: [],
      aftermathHookOnEvents: [],
      hazardBudget: 2,
    },
    host: {
      runAheadCapSeconds: 60,
      snapshotRingSeconds: 30,
      snapshotEverySeconds: 1,
      localSaveEverySeconds: 30,
      remoteSaveEverySeconds: 120,
      frameEveryTicks: 2,
      slowDownOnEvents: [],
      dirtFrameEverySeconds: 5,
    },
    watches: fixtureWatches([0]),
    mood: FIXTURE_MOOD,
    galley: FIXTURE_GALLEY,
    dirt: FIXTURE_DIRT,
    hazards: FIXTURE_HAZARDS,
    field: FIXTURE_FIELD,
    damage: FIXTURE_DAMAGE,
    intercom: FIXTURE_INTERCOM,
    bodies: FIXTURE_BODIES,
    expedition: FIXTURE_EXPEDITION,
    social: {
      chatRadiusTiles: 2,
      chatCooldownSeconds: 45,
      templateLines: ["{a} joked about the food", "{a} and {b} swapped gossip from the last port"],
      ...FIXTURE_SOCIAL,
    },
    recreation: FIXTURE_RECREATION,
    cabins: FIXTURE_CABINS,
    events: { tickerMaxEntries: 20, traceRingSize: 100 },
  };
}

export function tinyContent(config: ConfigDef = tinyConfig()): ContentBundle {
  return {
    decks: {
      [TINY.deck]: {
        id: TINY.deck,
        name: "Tiny deck",
        width: 6,
        height: 4,
        tiles: ["AAABBB", "AAABBB", "AAABBB", "AAABBB"],
        compartments: [
          { key: "hold", symbol: "A", name: "Hold", tags: ["cargoHold"] },
          { key: "engineering", symbol: "B", name: "Engineering", tags: ["engineering"] },
        ],
        doors: [
          {
            key: "holdDoor",
            edge: { x: 2, y: 1, side: "e" },
            kind: "interior",
            manualOperationSupported: true,
            initialState: "closed",
          },
        ],
        openings: [],
        walls: [],
        machines: [{ key: "pump1", machineDefId: TINY.pump, origin: { x: 4, y: 2 }, rotation: 0 }],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [{ key: "stores", name: "Stores", tags: ["cargoStowage"], tiles: [{ x: 0, y: 3 }] }],
        docking: {
          cargoRampDoorKey: "holdDoor",
          personnelRampDoorKey: "holdDoor",
          cargoTransferTiles: [{ x: 0, y: 0 }],
          personnelTransferTiles: [{ x: 0, y: 0 }],
        },
        hull: { class: "test_hull", sizeClass: "S", max: 100 },
        spawnPoints: [{ key: "bunk", tile: { x: 1, y: 1 }, tags: ["crew"] }],
      },
    },
    machines: {
      [TINY.pump]: {
        id: TINY.pump,
        name: "Coolant Pump",
        tags: ["cooling"],
        footprint: [{ x: 0, y: 0 }],
        interactionPositions: [
          { key: "front", offset: { x: -1, y: 0 }, purposes: ["repair", "operate"], capacity: 1 },
        ],
        power: { role: "consumer", drawKw: 2, priority: "criticalCooling", partialPower: "derate" },
        heat: { risePerSecond: 0.01, coolPerSecond: 0.02, derateAbove: 0.8 },
        operation: { requiresOperator: false },
        failure: { baseHazardPerSecond: 0.0001, heatFactor: 3, wearPerSecond: 0.0001 },
        faults: [
          {
            key: "wornBearing",
            name: "Worn bearing",
            weight: 1,
            effect: { kind: "derate", outputFactor: 0.5 },
            symptom: { key: "grinding", channel: "audible" },
            repair: {
              steps: [
                {
                  key: "replace",
                  action: "repair",
                  workSeconds: 10,
                  tools: ["wrench"],
                  consumes: [],
                  at: "repair",
                },
              ],
            },
          },
          {
            key: "seized",
            name: "Seized",
            weight: 1,
            effect: { kind: "inoperable" },
            symptom: { key: "silent", channel: "audible" },
            repair: { steps: [] },
          },
        ],
        components: [],
      },
    },
    items: {
      [TINY.wrench]: {
        id: TINY.wrench,
        name: "Wrench",
        stacking: "unique",
        maxStack: 1,
        tags: ["tool"],
        toolKinds: ["wrench"],
        mass: 1,
      },
      [TINY.rations]: {
        id: TINY.rations,
        name: "Ration pack",
        stacking: "stackable",
        maxStack: 10,
        tags: ["food", "consumable"],
        toolKinds: [],
        mass: 0.5,
        nutrition: 0.3,
      },
      [TINY.crate]: {
        id: TINY.crate,
        name: "Crate",
        stacking: "unique",
        maxStack: 1,
        tags: ["container", "cargo"],
        toolKinds: [],
        mass: 20,
        cargoClass: "general",
      },
    },
    crew: {
      [TINY.mara]: {
        id: TINY.mara,
        name: "Mara Voss",
        roleTags: ["captain"],
        skills: { piloting: 6 },
        startingInventory: [{ itemDefId: TINY.rations, count: 3 }],
        bio: "Keeps the ship flying.",
        voice: "Plain and brief.",
      },
    },
    traits: {},
    ports: {
      [TINY.port]: {
        id: TINY.port,
        name: "Tiny Dock",
        setting: "station",
        description: "A dock.",
        character: "A dock.",
        castSeed: [],
        externalStores: [{ key: "warehouse", name: "Warehouse", kind: "warehouse" }],
        market: [],
        jobTemplates: [],
        routes: [{ toPortId: TINY.port2, distance: 30 }],
      },
      [TINY.port2]: {
        id: TINY.port2,
        name: "Far Dock",
        setting: "station",
        description: "Another dock.",
        character: "Another dock.",
        castSeed: [],
        externalStores: [{ key: "warehouse", name: "Warehouse", kind: "warehouse" }],
        market: [],
        jobTemplates: [],
        routes: [
          { toPortId: TINY.port, distance: 30 },
          { toPortId: TINY.port3, distance: 40 },
        ],
      },
      [TINY.port3]: {
        id: TINY.port3,
        name: "Beyond Dock",
        setting: "station",
        description: "The dock past Far Dock.",
        character: "The dock past Far Dock.",
        castSeed: [],
        externalStores: [{ key: "warehouse", name: "Warehouse", kind: "warehouse" }],
        market: [],
        jobTemplates: [],
        routes: [{ toPortId: TINY.port2, distance: 40 }],
      },
    },
    scenarios: {
      [TINY.scenario]: {
        id: TINY.scenario,
        name: "Tiny",
        deckId: TINY.deck,
        startPortId: TINY.port,
        crew: [TINY.mara],
        startingMoney: 500,
        startingItems: [{ itemDefId: TINY.wrench, count: 1, zoneKey: "stores" }],
        initialFaults: [],
        watchBill: { sections: [{ key: "alpha", members: [TINY.mara] }], dayworkers: [] },
      },
    },
    thoughts: FIXTURE_THOUGHTS,
    activities: FIXTURE_ACTIVITIES,
    topics: FIXTURE_TOPICS,
    config,
    hash: "tiny-content-v1",
  };
}

export function tinyEffectiveConfig(config: ConfigDef = tinyConfig()): EffectiveConfig {
  return { values: config, hash: "tiny-config" };
}
