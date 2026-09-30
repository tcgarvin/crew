import { describe, expect, it } from "vitest";
import {
  NotImplementedError,
  configDefSchema,
  contentBundleSchema,
  crewDefSchema,
  deckDefSchema,
  itemDefSchema,
  machineDefSchema,
  portDefSchema,
  scenarioDefSchema,
  traitDefSchema,
  validateBundle,
  validateStructure,
} from "./index";

const deck = {
  id: "deck.test.main",
  name: "Test deck",
  width: 3,
  height: 1,
  tiles: ["aab"],
  compartments: [
    { key: "hold", symbol: "a", name: "Hold", tags: ["cargoHold"] },
    { key: "bridge", symbol: "b", name: "Bridge", tags: [] },
  ],
  doors: [
    {
      key: "d1",
      edge: { x: 1, y: 0, side: "e" },
      kind: "interior",
      manualOperationSupported: true,
      initialState: "closed",
    },
    {
      key: "ramp",
      edge: { x: 0, y: 0, side: "w" },
      kind: "ramp",
      manualOperationSupported: true,
      initialState: "closed",
    },
  ],
  openings: [],
  walls: [],
  machines: [
    { key: "pump1", machineDefId: "machine.test.pump", origin: { x: 2, y: 0 }, rotation: 0 },
  ],
  powerDomains: [{ key: "main", name: "Main bus" }],
  zones: [{ key: "stow", name: "Stowage", tags: ["cargoStowage"], tiles: [{ x: 0, y: 0 }] }],
  docking: {
    cargoRampDoorKey: "ramp",
    personnelRampDoorKey: "ramp",
    cargoTransferTiles: [{ x: 0, y: 0 }],
    personnelTransferTiles: [{ x: 0, y: 0 }],
  },
  spawnPoints: [{ key: "s1", tile: { x: 1, y: 0 }, tags: ["crew"] }],
};

const machine = {
  id: "machine.test.pump",
  name: "Pump",
  tags: ["cooling"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [
    { key: "front", offset: { x: -1, y: 0 }, purposes: ["repair", "operate"], capacity: 1 },
  ],
  power: { role: "consumer", drawKw: 3, priority: "criticalCooling", partialPower: "derate" },
  heat: { risePerSecond: 0.01, coolPerSecond: 0.02, derateAbove: 0.8 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0.001, heatFactor: 3, wearPerSecond: 0.0005 },
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
            skill: { skill: "engineering", min: 2 },
            tools: ["wrench"],
            consumes: [{ itemDefId: "item.test.bearing", count: 1 }],
            at: "repair",
          },
        ],
      },
    },
  ],
  components: [],
};

const item = {
  id: "item.test.wrench",
  name: "Wrench",
  stacking: "unique",
  maxStack: 1,
  tags: ["tool"],
  toolKinds: ["wrench"],
  mass: 1.2,
};

const crew = {
  id: "crew.test.mara",
  name: "Mara",
  roleTags: ["captain"],
  skills: { piloting: 5 },
  startingInventory: [],
  shift: "alpha",
  bio: "Test captain.",
};

const trait = {
  id: "trait.test.steady",
  name: "Steady",
  modifiers: { workSpeed: 1.1 },
  excludes: [],
};

const port = {
  id: "port.test.a",
  name: "Port A",
  description: "",
  externalStores: [{ key: "warehouse", name: "Warehouse", kind: "warehouse" }],
  jobTemplates: [
    {
      key: "parts",
      issuer: "Co-op",
      toPortId: "port.test.b",
      cargo: [{ itemDefId: "item.test.crate", countMin: 1, countMax: 3 }],
      weight: 1,
    },
  ],
  routes: [{ toPortId: "port.test.b", distance: 40 }],
};

const scenario = {
  id: "scenario.test.default",
  name: "Test",
  deckId: "deck.test.main",
  startPortId: "port.test.a",
  crew: ["crew.test.mara"],
  startingMoney: 1000,
  startingItems: [{ itemDefId: "item.test.wrench", count: 1, zoneKey: "stow" }],
  initialFaults: [],
};

const band = { min: 1, max: 3 };
const config = {
  time: { tickRate: 20 },
  movement: {
    walkSpeed: 2,
    passDelaySeconds: 0.3,
    blockedRerouteSeconds: 2,
    fatigueSpeedFloor: 0.6,
    loadSpeedPerKg: 0.01,
    loadSpeedFloor: 0.5,
  },
  doors: { openSeconds: 0.7, closeSeconds: 0.7, autoCloseAfterSeconds: 2, manualOpenSeconds: 4 },
  needs: {
    hungerPerSecond: 0.001,
    fatiguePerSecondAwake: 0.0008,
    fatiguePerSecondWorking: 0.0012,
    fatigueRecoveryPerSecondAsleep: 0.004,
    comfortPerSecond: 0.0005,
    comfortRecoveryPerSecondResting: 0.003,
    socialPerSecond: 0.0005,
    socialRecoveryPerSecondChatting: 0.01,
    seekThreshold: 0.5,
    mealSeconds: 15,
    sleepMinSeconds: 60,
    wakeBelow: 0.1,
  },
  work: {
    reconsiderEveryTicks: 10,
    switchCooldownSeconds: 2,
    claimLeaseSeconds: 4,
    timeBucketSeconds: 1,
    retryBackoffSeconds: 5,
    skillGainPerSecond: 0.0001,
    workSpeedPerSkillLevel: 0.1,
  },
  urgency: {
    needEssentialAbove: 0.8,
    needSurvivalAbove: 0.95,
    heatContainmentAbove: 0.7,
    heatSurvivalAbove: 0.9,
    routineAgingSeconds: 120,
  },
  equipment: { hazardScale: 1, overheatDamagePerSecond: 0.01, maintenanceConditionBelow: 0.3 },
  power: { priorityOrder: ["lifeSupport", "criticalCooling", "propulsion", "domestic", "cargo"] },
  travel: {
    prepareDepartureSeconds: 5,
    undockSeconds: 4,
    departSeconds: 5,
    approachSeconds: 5,
    dockSeconds: 4,
    nominalSpeed: 1,
  },
  commerce: {
    priceBands: { general: band, fragile: band, perishable: band, hazardous: band },
    jobOfferTtlSeconds: 300,
    boardSize: 3,
  },
  narrator: {
    quietTooLongSeconds: 180,
    approachHookLeadSeconds: 10,
    maxSpawnsPerCommand: 4,
    maxFaultWindowSeconds: 120,
    spawnBudget: 4,
    faultBudget: 2,
    budgetRefillSeconds: 600,
  },
  host: {
    runAheadCapSeconds: 60,
    snapshotRingSeconds: 90,
    snapshotEverySeconds: 1,
    localSaveEverySeconds: 10,
    remoteSaveEverySeconds: 60,
    frameEveryTicks: 2,
  },
  shifts: { cycleSeconds: 600, shifts: [{ key: "alpha", workWindows: [[0, 300]] }] },
  events: { tickerMaxEntries: 20, traceRingSize: 500 },
};

const cases = [
  { name: "deck", schema: deckDefSchema, valid: deck, invalid: { ...deck, width: 0 } },
  {
    name: "machine",
    schema: machineDefSchema,
    valid: machine,
    invalid: { ...machine, power: { role: "consumer", drawKw: 3 } },
  },
  { name: "item", schema: itemDefSchema, valid: item, invalid: { ...item, stacking: "pile" } },
  {
    name: "crew",
    schema: crewDefSchema,
    valid: crew,
    invalid: { ...crew, skills: { juggling: 3 } },
  },
  {
    name: "trait",
    schema: traitDefSchema,
    valid: trait,
    invalid: { ...trait, modifiers: { workSpeed: 100 } },
  },
  { name: "port", schema: portDefSchema, valid: port, invalid: { ...port, id: "Port A" } },
  {
    name: "scenario",
    schema: scenarioDefSchema,
    valid: scenario,
    invalid: { ...scenario, crew: [] },
  },
  {
    name: "config",
    schema: configDefSchema,
    valid: config,
    invalid: { ...config, time: { tickRate: 0 } },
  },
] as const;

describe("content def schemas", () => {
  for (const c of cases) {
    it(`${c.name}: parses a minimal valid example`, () => {
      expect(c.schema.safeParse(c.valid).success).toBe(true);
    });
    it(`${c.name}: rejects an invalid example`, () => {
      expect(c.schema.safeParse(c.invalid).success).toBe(false);
    });
  }

  it("rejects unknown keys (authored JSON typos)", () => {
    expect(itemDefSchema.safeParse({ ...item, maxStak: 1 }).success).toBe(false);
  });

  it("rejects an explicit undefined for an optional key", () => {
    expect(itemDefSchema.safeParse({ ...item, cargoClass: undefined }).success).toBe(false);
  });
});

describe("bundle validation", () => {
  const bundle = {
    decks: { [deck.id]: deck },
    machines: { [machine.id]: machine },
    items: { [item.id]: item },
    crew: { [crew.id]: crew },
    traits: { [trait.id]: trait },
    ports: { [port.id]: port },
    scenarios: { [scenario.id]: scenario },
    config,
    hash: "test",
  };

  it("L1 accepts a structurally valid bundle", () => {
    expect(contentBundleSchema.safeParse(bundle).success).toBe(true);
    expect(validateStructure(bundle).ok).toBe(true);
  });

  it("L1 reports issues with paths", () => {
    const result = validateStructure({ ...bundle, items: { [item.id]: { ...item, mass: -1 } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toEqual(["items", item.id, "mass"]);
      expect(result.issues[0]?.level).toBe("structural");
    }
  });

  it("validateBundle returns L1 issues and otherwise hits the L2 stub", () => {
    expect(validateBundle({}).ok).toBe(false);
    expect(() => validateBundle(bundle)).toThrow(NotImplementedError);
  });
});
