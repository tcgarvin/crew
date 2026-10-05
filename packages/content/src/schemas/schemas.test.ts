import { describe, expect, it } from "vitest";
import {
  configDefSchema,
  contentBundleSchema,
  crewDefSchema,
  deckDefSchema,
  itemDefSchema,
  machineDefSchema,
  peopleTableDefSchema,
  portDefSchema,
  scenarioDefSchema,
  traitDefSchema,
  validateBundle,
  validatePhysical,
  validateReferences,
  validateStructure,
} from "./index";
import type { ValidationIssue } from "./issues";

const door = (key: string, x: number, y: number, side: string, kind = "interior") => ({
  key,
  edge: { x, y, side },
  kind,
  manualOperationSupported: true,
  initialState: "closed",
});

/** A single-tile machine on the top row, used from the tile south of it (rotation 270). */
const placed = (key: string, machineDefId: string, x: number) => ({
  key,
  machineDefId,
  origin: { x, y: 0 },
  rotation: 270,
});

/**
 * The smallest deck that meets the hull contract (D72): bridge on the east edge, both ramps south,
 * every required room, station, zone and spawn point, and beds for the one crew member plus one.
 */
const deck = {
  id: "deck.test.main",
  name: "Test deck",
  width: 8,
  height: 3,
  tiles: ["EEGGQQBB", "EEGGQQBB", "HHHHHAAB"],
  compartments: [
    { key: "hold", symbol: "H", name: "Hold", tags: ["cargoHold"] },
    { key: "engineering", symbol: "E", name: "Engineering", tags: ["engineering"] },
    { key: "galley", symbol: "G", name: "Galley", tags: ["galley", "mess"] },
    { key: "quarters", symbol: "Q", name: "Quarters", tags: ["quarters"] },
    { key: "bridge", symbol: "B", name: "Bridge", tags: ["bridge"] },
    { key: "airlock", symbol: "A", name: "Airlock", tags: ["airlock"] },
  ],
  doors: [
    door("d1", 1, 0, "e"),
    door("d2", 3, 1, "e"),
    door("d3", 5, 1, "e"),
    door("d4", 0, 1, "s"),
    door("d5", 4, 2, "e"),
    door("ramp", 1, 2, "s", "ramp"),
    door("personnel_ramp", 5, 2, "s", "ramp"),
  ],
  openings: [],
  walls: [],
  machines: [
    placed("engine1", "machine.test.engine", 0),
    placed("pump1", "machine.test.pump", 1),
    placed("stove1", "machine.test.stove", 2),
    // two tables of two seats each, in the middle row where every side is floor (D81)
    { key: "table1", machineDefId: "machine.test.table", origin: { x: 3, y: 1 }, rotation: 0 },
    { key: "table2", machineDefId: "machine.test.table", origin: { x: 6, y: 1 }, rotation: 0 },
    placed("bunk1", "machine.test.bunk", 4),
    placed("bunk2", "machine.test.bunk", 5),
    placed("helm1", "machine.test.helm", 6),
    placed("nav1", "machine.test.nav", 7),
  ],
  powerDomains: [{ key: "main", name: "Main bus" }],
  zones: [
    { key: "stow", name: "Stowage", tags: ["cargoStowage"], tiles: [{ x: 2, y: 2 }] },
    { key: "pantry", name: "Pantry", tags: ["pantry"], tiles: [{ x: 0, y: 2 }] },
    // the stove's use tile is (2,1), so (1,1) is beside it
    { key: "serving", name: "Serving", tags: ["serving"], tiles: [{ x: 1, y: 1 }] },
    { key: "mops", name: "Mops", tags: ["cleaningLocker"], tiles: [{ x: 4, y: 2 }] },
  ],
  docking: {
    cargoRampDoorKey: "ramp",
    personnelRampDoorKey: "personnel_ramp",
    cargoTransferTiles: [{ x: 1, y: 2 }],
    personnelTransferTiles: [{ x: 5, y: 2 }],
  },
  hull: { class: "test_hull", sizeClass: "S" },
  spawnPoints: [
    { key: "s1", tile: { x: 3, y: 2 }, tags: ["crew"] },
    { key: "p1", tile: { x: 6, y: 2 }, tags: ["passenger"] },
  ],
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
            consumes: [{ itemDefId: "item.test.wrench", count: 1 }],
            at: "repair",
          },
        ],
      },
    },
  ],
  components: [],
};

/** The pump's shape with one tag and no faults: the stations and furniture the deck needs. */
const inertMachine = (name: string, tag: string) => ({
  ...machine,
  id: `machine.test.${name}`,
  name,
  tags: [tag],
  faults: [],
});
/** The helm: a seat, a standby tile apart from it (D77), and piloting 3 to stand it. */
const helm = {
  ...inertMachine("helm", "pilotStation"),
  interactionPositions: [
    { key: "seat", offset: { x: -1, y: 0 }, purposes: ["operate", "repair"], capacity: 1 },
    { key: "standby", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 },
  ],
  operation: { requiresOperator: true, operatorSkill: { skill: "piloting", min: 3 } },
};
/** A stove with a `use` position for the cook, and tables seating two each (D81). */
const SIDES = [
  { x: -1, y: 0 },
  { x: 0, y: 1 },
];
const withUse = (name: string, tag: string, seats: number) => ({
  ...inertMachine(name, tag),
  interactionPositions: SIDES.slice(0, seats).map((offset, i) => ({
    key: `use_${i}`,
    offset,
    purposes: ["use"],
    capacity: 1,
  })),
});
const furniture = [
  inertMachine("engine", "engine"),
  withUse("stove", "stove", 1),
  withUse("table", "messTable", 2),
  inertMachine("bunk", "bed"),
  helm,
  inertMachine("nav", "navStation"),
];

const item = {
  id: "item.test.wrench",
  name: "Wrench",
  stacking: "unique",
  maxStack: 1,
  tags: ["tool"],
  toolKinds: ["wrench"],
  mass: 1.2,
};

// D81: the galley finds its crate and its plate by tag; L2 wants exactly one meal def.
const provisions = {
  id: "item.test.provisions",
  name: "Provisions",
  stacking: "stackable",
  maxStack: 20,
  tags: ["provisions"],
  toolKinds: [],
  mass: 2,
};
const meal = {
  id: "item.test.meal",
  name: "Hot Meal",
  stacking: "stackable",
  maxStack: 20,
  tags: ["food", "consumable", "meal"],
  toolKinds: [],
  mass: 0.5,
  nutrition: 0.4,
};

const crew = {
  id: "crew.test.mara",
  name: "Mara",
  roleTags: ["captain"],
  skills: { piloting: 5 },
  startingInventory: [],
  bio: "Test captain.",
  voice: "Plain and brief.",
};

const trait = {
  id: "trait.test.steady",
  name: "Steady",
  modifiers: { workSpeed: 1.1 },
  excludes: [],
};

const castSeed = [
  { name: "Ada Test", role: "berth agent", note: "Runs the dock." },
  { name: "Bo Test", role: "broker", note: "Wants freight moved." },
];

const port = {
  id: "port.test.a",
  name: "Port A",
  setting: "station",
  description: "",
  character: "A test port where testers test.",
  castSeed,
  externalStores: [{ key: "warehouse", name: "Warehouse", kind: "warehouse" }],
  market: [{ itemDefId: "item.test.wrench", count: 2, price: 40 }],
  jobTemplates: [
    {
      key: "parts",
      issuer: "Co-op",
      toPortId: "port.test.b",
      cargo: [{ itemDefId: "item.test.wrench", countMin: 1, countMax: 3 }],
      weight: 1,
    },
  ],
  routes: [{ toPortId: "port.test.b", distance: 40 }],
};

const portB = {
  id: "port.test.b",
  name: "Port B",
  setting: "planet",
  description: "",
  character: "Another test port.",
  castSeed,
  externalStores: [{ key: "warehouse", name: "Warehouse B", kind: "warehouse" }],
  market: [],
  jobTemplates: [],
  routes: [{ toPortId: "port.test.a", distance: 40 }],
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

const thought = (key: string, value: number, stacks: boolean) => ({
  key,
  label: key,
  value,
  durationDays: 0.5,
  stacks,
});
const thoughts = {
  stoodLongWatch: thought("stoodLongWatch", -0.15, false),
  doubleWatch: thought("doubleWatch", -0.25, false),
  helmCleanPass: thought("helmCleanPass", 0.1, true),
  helmScrape: thought("helmScrape", -0.1, true),
  ateWell: thought("ateWell", 0.1, false),
  burntDinner: thought("burntDinner", -0.1, false),
  ateRationPack: thought("ateRationPack", -0.05, false),
  ateInDirtyMess: thought("ateInDirtyMess", -0.1, false),
  ateInFilthyMess: thought("ateInFilthyMess", -0.2, false),
};

const band = { min: 1, max: 3 };
const config = {
  time: { tickRate: 20, daySeconds: 1200, watchesPerDay: 3 },
  movement: {
    walkSpeed: 2,
    passDelaySeconds: 0.3,
    blockedRerouteSeconds: 2,
    fatigueSpeedFloor: 0.6,
    loadSpeedPerKg: 0.01,
    loadSpeedFloor: 0.5,
  },
  doors: {
    openSeconds: 0.7,
    closeSeconds: 0.7,
    autoCloseAfterSeconds: 2,
    manualOpenSeconds: 4,
    rampOpenSeconds: 2,
  },
  needs: {
    hungerPerDay: 1.2,
    fatiguePerDayAwake: 0.96,
    fatiguePerDayWorking: 1.44,
    fatigueRecoveryPerDayAsleep: 4.8,
    comfortPerDay: 0.6,
    comfortRecoveryPerDayResting: 3.6,
    socialPerDay: 0.6,
    socialRecoveryPerDayChatting: 12,
    seekThreshold: 0.5,
    mealDays: 0.0125,
    sleepDays: 0.05,
    wakeBelow: 0.1,
    bedtimeAbove: 0.3,
    initialRange: {
      hunger: { min: 0.2, max: 0.6 },
      fatigue: { min: 0.1, max: 0.5 },
      comfort: { min: 0, max: 0.3 },
      social: { min: 0.1, max: 0.5 },
    },
  },
  work: {
    reconsiderEveryTicks: 10,
    switchCooldownSeconds: 2,
    claimLeaseSeconds: 4,
    timeBucketSeconds: 1,
    retryBackoffSeconds: 5,
    skillGainPerDay: 0.12,
    workSpeedPerSkillLevel: 0.1,
  },
  urgency: {
    needEssentialAbove: 0.8,
    needSurvivalAbove: 0.95,
    heatContainmentAbove: 0.7,
    heatSurvivalAbove: 0.9,
    routineAgingDays: 0.1,
  },
  equipment: {
    hazardScale: 1,
    overheatDamagePerSecond: 0.01,
    maintenanceConditionBelow: 0.3,
    integrityDerateBelow: 0.5,
    integrityInoperableBelow: 0.15,
  },
  power: { priorityOrder: ["lifeSupport", "criticalCooling", "propulsion", "domestic", "cargo"] },
  travel: {
    prepareDepartureSeconds: 5,
    undockSeconds: 4,
    departSeconds: 5,
    approachSeconds: 5,
    dockSeconds: 4,
    nominalSpeed: 1,
    staffEstimateSeconds: 0,
    departureMinOutput: 0.5,
    // D80: no limp unless a test turns it on.
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
      general: band,
      fragile: band,
      perishable: band,
      hazardous: band,
      passenger: band,
    },
    jobOfferTtlDays: 0.25,
    dockingFee: 0,
    haulEstimateSeconds: 5,
    reofferDays: 0.05,
    maxCratesPerJob: 6,
    passage: { ashoreDaysMin: 0.05, ashoreDaysMax: 0.15, overdueDays: 0.1 },
    // D80: off unless a test turns them on.
    sparesReserve: 0,
    foodReserve: { lowBelowDays: 0, restockToDays: 0 },
    market: {
      priceTiers: { cheap: 0.6, fair: 1, dear: 1.6 },
      maxStockPerCommand: 4,
      defaultPrice: 100,
      buySeconds: 3,
    },
  },
  narrator: {
    quietTooLongDays: 0.15,
    approachHookLeadSeconds: 10,
    maxSpawnsPerCommand: 4,
    maxFaultWindowSeconds: 120,
    spawnBudget: 4,
    faultBudget: 2,
    budgetRefillDays: 0.5,
    hookOnEvents: [],
    hazardBudget: 2,
  },
  host: {
    runAheadCapSeconds: 60,
    snapshotRingSeconds: 90,
    snapshotEverySeconds: 1,
    localSaveEverySeconds: 10,
    remoteSaveEverySeconds: 60,
    frameEveryTicks: 2,
    slowDownOnEvents: [],
    dirtFrameEverySeconds: 5,
  },
  watches: {
    dayworkerOnWatches: [0, 1],
    handoverLeadSeconds: 30,
    handoverSeconds: 5,
    reliefMaxDays: 0.1,
    reliefNoShowSeconds: 45,
    longWatchFactor: 1.25,
    helmUnattendedSeconds: 20,
    roundsStopSeconds: 4,
    roundsEveryDays: 0.08,
    plotCourseSeconds: 20,
  },
  mood: { lowBelow: -0.4, highAbove: 0.4, lowWorkSpeed: 0.9, highWorkSpeed: 1.05 },
  galley: {
    mealLeadDays: 0.08,
    mealGraceDays: 0.1,
    cookSeconds: 30,
    substituteAfterDays: 0.025,
    spareServings: 1,
    servingsPerCrate: 12,
    mealSpoilDays: 0.25,
    mealCallHungerAbove: 0.2,
    lowBelowDays: 1,
    restockToDays: 4,
    goodCookingAbove: 6,
    poorCookingBelow: 3,
  },
  dirt: {
    footfallPerStep: 0.004,
    bootsPickup: 0.15,
    bootsShed: 0.25,
    dockGrimePerStep: 0.08,
    airborneDustPerDay: 0.5,
    airborneDustRadiusTiles: 6,
    airborneDustVisitCap: 0.3,
    deposits: {
      cooking: 0.04,
      serving: 0.03,
      eating: 0.02,
      spoiledMeal: 0.08,
      repair: 0.05,
      cargo: 0.03,
    },
    depositRadiusTiles: 1,
    roomMaxWeight: 0.3,
    tiers: { untidy: 0.12, dirty: 0.3, filthy: 0.55 },
    tierHysteresis: 0.05,
    mopPerTile: 1,
    mopSecondsPerTile: 2,
    mopTilesPerTrip: 12,
    updateEverySeconds: 1,
    tintScale: 1.2,
    tintMaxAlpha: 0.35,
  },
  hazards: { difficulty: { easy: 3, hard: 5, brutal: 7 }, delaySeconds: 60 },
  social: { chatRadiusTiles: 2, chatCooldownSeconds: 45, templateLines: ["{a} joked"] },
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
    invalid: { ...config, time: { ...config.time, tickRate: 0 } },
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

  it("requires a voice on every crew member (D38)", () => {
    const { voice: _omitted, ...voiceless } = crew;
    expect(crewDefSchema.safeParse(voiceless).success).toBe(false);
    expect(crewDefSchema.safeParse({ ...crew, voice: "" }).success).toBe(false);
  });
});

const people = {
  givenNames: ["Ysolde"],
  familyNames: ["Maren"],
  pitches: ["I've got {cargo} for {to}."],
  cargoWords: {
    general: "general freight",
    fragile: "fragile equipment",
    perishable: "fresh produce",
    hazardous: "hazardous cargo",
  },
  ports: {
    "port.test.a": { roles: ["grower"], orgs: ["Test Growers"], pitches: [] },
  },
};

describe("people table (D25)", () => {
  it("accepts a valid table", () => {
    expect(peopleTableDefSchema.safeParse(people).success).toBe(true);
  });

  it("rejects a pitch that mentions a number (D24: no pay on cards)", () => {
    const bad = { ...people, pitches: ["I'll pay 500 for it."] };
    expect(peopleTableDefSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown placeholder", () => {
    const bad = { ...people, pitches: ["Ask {captain} about it."] };
    expect(peopleTableDefSchema.safeParse(bad).success).toBe(false);
  });
});

/** Runs one validation level on `input`, which must pass L1. */
function issuesAt(
  level: typeof validateReferences | typeof validatePhysical,
  input: unknown,
): readonly ValidationIssue[] {
  const parsed = validateStructure(input);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("structurally invalid");
  return level(parsed.bundle);
}

const referenceIssues = (input: unknown) => issuesAt(validateReferences, input);
const physicalIssues = (input: unknown) => issuesAt(validatePhysical, input);

describe("bundle validation", () => {
  const bundle = {
    decks: { [deck.id]: deck },
    machines: Object.fromEntries([machine, ...furniture].map((m) => [m.id, m])),
    items: { [item.id]: item, [provisions.id]: provisions, [meal.id]: meal },
    crew: { [crew.id]: crew },
    traits: { [trait.id]: trait },
    ports: { [port.id]: port, [portB.id]: portB },
    scenarios: { [scenario.id]: scenario },
    people,
    docks: {},
    thoughts,
    config,
    hash: "test",
  };

  it("L1 accepts a structurally valid bundle", () => {
    expect(contentBundleSchema.safeParse(bundle).success).toBe(true);
    expect(validateStructure(bundle).ok).toBe(true);
  });

  it("L1 requires every thought def, and a bill with distinct sections and members (D77, D79)", () => {
    const { helmScrape: _missing, ...three } = thoughts;
    expect(validateStructure({ ...bundle, thoughts: three }).ok).toBe(false);
    const bill = (sections: unknown, dayworkers: unknown) => ({
      ...bundle,
      scenarios: { [scenario.id]: { ...scenario, watchBill: { sections, dayworkers } } },
    });
    const red = { key: "red", members: ["crew.test.mara"] };
    expect(validateStructure(bill([red], [])).ok).toBe(true);
    expect(validateStructure(bill([], [])).ok).toBe(false);
    expect(validateStructure(bill([red, { key: "red", members: [] }], [])).ok).toBe(false);
    expect(validateStructure(bill([red], ["crew.test.mara"])).ok).toBe(false);
    expect(
      validateStructure(bill([red, { key: "white", members: ["crew.test.mara"] }], [])).ok,
    ).toBe(false);
    expect(
      validateStructure(bill([{ key: "red", members: ["crew.test.mara", "crew.test.mara"] }], []))
        .ok,
    ).toBe(false);
  });

  it("L1 reports issues with paths", () => {
    const result = validateStructure({ ...bundle, items: { [item.id]: { ...item, mass: -1 } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toEqual(["items", item.id, "mass"]);
      expect(result.issues[0]?.level).toBe("structural");
    }
  });

  it("validateBundle accepts a fully valid bundle through L1-L3", () => {
    const result = validateBundle(bundle);
    expect(result.ok).toBe(true);
  });

  it("validateBundle still returns L1 issues for a structurally invalid bundle", () => {
    expect(validateBundle({}).ok).toBe(false);
  });

  describe("L2 referential rules", () => {
    it("rejects a record key that does not match its def id", () => {
      const issues = referenceIssues({ ...bundle, items: { "item.test.other": item } });
      expect(
        issues.some((i) => i.level === "referential" && i.message.includes("item.test.other")),
      ).toBe(true);
    });

    it("rejects a watch-bill member who is not in the scenario's crew (D77)", () => {
      const billed = {
        ...scenario,
        watchBill: {
          sections: [{ key: "red", members: ["crew.test.mara"] }],
          dayworkers: ["crew.test.stranger"],
        },
      };
      const issues = referenceIssues({ ...bundle, scenarios: { [scenario.id]: billed } });
      expect(
        issues.some((i) => i.message.includes("crew.test.stranger") && i.message.includes("bill")),
      ).toBe(true);
      const ok = { ...billed, watchBill: { ...billed.watchBill, dayworkers: [] } };
      expect(referenceIssues({ ...bundle, scenarios: { [scenario.id]: ok } })).toEqual([]);
    });

    it("rejects a dayworker watch outside the day, or listed twice (D77)", () => {
      const bad = { ...config, watches: { ...config.watches, dayworkerOnWatches: [1, 3, 1] } };
      const issues = referenceIssues({ ...bundle, config: bad });
      expect(issues.some((i) => i.message.includes("watch 3 is not one of the 3"))).toBe(true);
      expect(issues.some((i) => i.message.includes("watch 1 is listed twice"))).toBe(true);
    });

    it("rejects a thought filed under another thought's key (D79)", () => {
      const swapped = { ...thoughts, doubleWatch: thoughts.stoodLongWatch };
      const issues = referenceIssues({ ...bundle, thoughts: swapped });
      expect(issues.some((i) => i.path.join(".") === "thoughts.doubleWatch.key")).toBe(true);
    });

    it("rejects an id outside its table's namespace", () => {
      const badItem = { ...item, id: "trait.test.not_an_item" };
      const issues = referenceIssues({ ...bundle, items: { [badItem.id]: badItem } });
      expect(issues.some((i) => i.message.includes("must start with"))).toBe(true);
    });

    it("rejects a market line naming an unknown item, and a duplicate line (D47)", () => {
      const badPort = {
        ...port,
        market: [
          { itemDefId: "item.test.nothing", count: 1, price: 10 },
          { itemDefId: "item.test.wrench", count: 1, price: 10 },
          { itemDefId: "item.test.wrench", count: 2, price: 12 },
        ],
      };
      const issues = referenceIssues({
        ...bundle,
        ports: { ...bundle.ports, [port.id]: badPort },
      });
      expect(issues.some((i) => i.message.includes("item.test.nothing"))).toBe(true);
      expect(issues.some((i) => i.message.includes("duplicate market item"))).toBe(true);
      const negative = validateStructure({
        ...bundle,
        ports: {
          ...bundle.ports,
          [port.id]: { ...port, market: [{ itemDefId: "item.test.wrench", count: -1, price: 10 }] },
        },
      });
      expect(negative.ok).toBe(false);
    });

    it("rejects a zone whose machineKey names no placement on its deck (D72)", () => {
      const locker = {
        key: "locker_1",
        name: "Locker",
        tags: ["locker"],
        tiles: [{ x: 4, y: 1 }],
        machineKey: "bunk9",
      };
      const badDeck = { ...deck, zones: [...deck.zones, locker] };
      const issues = referenceIssues({ ...bundle, decks: { [badDeck.id]: badDeck } });
      expect(issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
        'decks.deck.test.main.zones.4.machineKey: zone "locker_1" names unknown machine placement "bunk9"',
      ]);
    });

    it("rejects a dangling item reference in a crew starting inventory", () => {
      const badCrew = {
        ...crew,
        startingInventory: [{ itemDefId: "item.does.not_exist", count: 1 }],
      };
      const issues = referenceIssues({ ...bundle, crew: { [badCrew.id]: badCrew } });
      expect(issues.some((i) => i.message.includes("item.does.not_exist"))).toBe(true);
    });

    it("rejects a generated given name that is a crew member's first name", () => {
      const clash = { ...people, givenNames: ["Ysolde", "Mara"] };
      const issues = referenceIssues({ ...bundle, people: clash });
      expect(issues.map((i) => [i.path, i.message])).toEqual([
        [["people", "givenNames", 1], `given name "Mara" is the first name of crew "${crew.id}"`],
      ]);
      expect(referenceIssues(bundle)).toEqual([]);
    });

    it("rejects a unique item with maxStack other than 1", () => {
      const badItem = { ...item, maxStack: 2 };
      const issues = referenceIssues({ ...bundle, items: { [badItem.id]: badItem } });
      expect(issues.some((i) => i.message.includes("must have maxStack 1"))).toBe(true);
    });

    it("holds capacityUnits to hand trucks, and every hand truck to a load of two or more (D65)", () => {
      const issuesFor = (bad: Record<string, unknown>) =>
        referenceIssues({
          ...bundle,
          items: { [item.id]: { ...item, ...bad }, [provisions.id]: provisions, [meal.id]: meal },
        }).map((i) => i.message);
      const truck = { toolKinds: ["handTruck"] };
      expect(issuesFor({ ...truck, capacityUnits: 4 })).toEqual([]);
      expect(issuesFor(truck).some((m) => m.includes("capacityUnits of at least 2"))).toBe(true);
      expect(issuesFor({ ...truck, capacityUnits: 1 }).some((m) => m.includes("at least 2"))).toBe(
        true,
      );
      expect(
        issuesFor({ ...truck, capacityUnits: 4, stacking: "stackable", maxStack: 3 }).some((m) =>
          m.includes("must be unique"),
        ),
      ).toBe(true);
      expect(issuesFor({ capacityUnits: 4 }).some((m) => m.includes("only a handTruck tool"))).toBe(
        true,
      );
      expect(
        validateStructure({ ...bundle, items: { [item.id]: { ...item, capacityUnits: 0 } } }).ok,
      ).toBe(false);
    });

    it("rejects a port without character or with fewer than two cast seeds (spec §2.4)", () => {
      const { character: _dropped, ...noCharacter } = port;
      expect(portDefSchema.safeParse(noCharacter).success).toBe(false);
      expect(portDefSchema.safeParse({ ...port, character: "" }).success).toBe(false);
      expect(portDefSchema.safeParse({ ...port, castSeed: [castSeed[0]] }).success).toBe(false);
      expect(
        portDefSchema.safeParse({ ...port, castSeed: [...castSeed, ...castSeed] }).success,
      ).toBe(false);
      expect(portDefSchema.safeParse(port).success).toBe(true);
    });

    it("rejects a route whose return leg has a different distance", () => {
      const farB = { ...portB, routes: [{ toPortId: port.id, distance: 99 }] };
      const issues = referenceIssues({
        ...bundle,
        ports: { [port.id]: port, [farB.id]: farB },
      });
      expect(issues.some((i) => i.message.includes("does not match return distance"))).toBe(true);
    });

    it("rejects asymmetric port routes", () => {
      const lonelyB = { ...portB, routes: [] };
      const issues = referenceIssues({
        ...bundle,
        ports: { [port.id]: port, [lonelyB.id]: lonelyB },
      });
      expect(issues.some((i) => i.message.includes("no return route"))).toBe(true);
    });

    it("rejects an inverted price band", () => {
      const badConfig = {
        ...config,
        commerce: {
          ...config.commerce,
          priceBands: { ...config.commerce.priceBands, general: { min: 5, max: 1 } },
        },
      };
      const issues = referenceIssues({ ...bundle, config: badConfig });
      expect(issues.some((i) => i.message.includes("exceeds max"))).toBe(true);
    });
  });

  describe("L3 physical rules", () => {
    it("rejects a door that is not on a compartment boundary", () => {
      const badDeck = {
        ...deck,
        doors: deck.doors.map((d) =>
          d.key === "d1" ? { ...d, edge: { x: 0, y: 0, side: "e" } } : d,
        ),
      };
      const issues = physicalIssues({ ...bundle, decks: { [badDeck.id]: badDeck } });
      expect(issues.some((i) => i.message.includes("two different compartments"))).toBe(true);
    });

    it("rejects a ramp that is not on a hull edge", () => {
      const badDeck = {
        ...deck,
        doors: deck.doors.map((d) =>
          d.key === "ramp" ? { ...d, edge: { x: 1, y: 0, side: "e" } } : d,
        ),
      };
      const issues = physicalIssues({ ...bundle, decks: { [badDeck.id]: badDeck } });
      expect(issues.some((i) => i.message.includes("hull edge"))).toBe(true);
    });

    it("rejects a disconnected compartment (deck connectivity)", () => {
      const badDeck = { ...deck, doors: deck.doors.filter((d) => d.key !== "d1") };
      const issues = physicalIssues({ ...bundle, decks: { [badDeck.id]: badDeck } });
      expect(issues.some((i) => i.message.includes("not reachable"))).toBe(true);
    });

    it("rejects overlapping machine footprints", () => {
      const badDeck = {
        ...deck,
        machines: [
          ...deck.machines,
          { key: "pump2", machineDefId: "machine.test.pump", origin: { x: 1, y: 0 }, rotation: 0 },
        ],
      };
      const issues = physicalIssues({ ...bundle, decks: { [badDeck.id]: badDeck } });
      expect(issues.some((i) => i.message.includes("overlaps"))).toBe(true);
    });

    it("holds every deck to the hull contract (D72)", () => {
      const westward = {
        ...deck,
        tiles: ["BBEEGGQQ", "BBEEGGQQ", "BHHHHHAA"],
      };
      const issues = physicalIssues({ ...bundle, decks: { [westward.id]: westward } });
      expect(issues.map((i) => i.message)).toContain(
        "the bridge does not reach the east hull edge (x = 7); the bow is east",
      );
    });

    it("gives each of a scenario's crew a crew spawn point", () => {
      const crowded = { ...scenario, crew: ["crew.test.mara", "crew.test.mara"] };
      const issues = physicalIssues({ ...bundle, scenarios: { [scenario.id]: crowded } });
      // Two crew also outgrow the deck's two beds (crew + 1, D73); validate-hull.test.ts covers that.
      expect(issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toContain(
        'scenarios.scenario.test.default.crew: 2 crew but "deck.test.main" has 1 crew spawn points',
      );
    });

    it("rejects a spawn point off the floor", () => {
      const badDeck = {
        ...deck,
        spawnPoints: [{ key: "s1", tile: { x: 5, y: 5 }, tags: ["crew"] }],
      };
      const issues = physicalIssues({ ...bundle, decks: { [badDeck.id]: badDeck } });
      expect(issues.some((i) => i.message.includes("is not floor"))).toBe(true);
    });

    it("rejects a recipe step whose tool kind no item satisfies", () => {
      const badMachine = {
        ...machine,
        faults: [
          {
            ...machine.faults[0],
            repair: {
              steps: [{ ...machine.faults[0]?.repair.steps[0], tools: ["welder"] }],
            },
          },
        ],
      };
      const issues = physicalIssues({ ...bundle, machines: { [badMachine.id]: badMachine } });
      expect(issues.some((i) => i.message.includes("no item def provides tool kind"))).toBe(true);
    });

    it("rejects a scenario that does not carry a tool its deck's repair recipes need (D71)", () => {
      const bareScenario = { ...scenario, startingItems: [] };
      const issues = physicalIssues({ ...bundle, scenarios: { [scenario.id]: bareScenario } });
      expect(
        issues.some((i) => i.message.includes('no starting item provides tool kind "wrench"')),
      ).toBe(true);
    });

    it("accepts a scenario that carries every tool its deck's recipes need", () => {
      const issues = physicalIssues(bundle);
      expect(issues.filter((i) => i.message.includes("no starting item provides"))).toEqual([]);
    });

    it("holds the pilot station to its standby position (D77)", () => {
      const seatOnly = { ...helm, interactionPositions: helm.interactionPositions.slice(0, 1) };
      const issues = physicalIssues({
        ...bundle,
        machines: { ...bundle.machines, [helm.id]: seatOnly },
      });
      expect(issues.map((i) => i.message)).toContain(
        'pilot station "helm1" (machine.test.helm) has no standby position: a "use" position apart from its "operate" seat',
      );
    });

    describe("the watch bill (D77)", () => {
      /** Hands with the given piloting; the helm needs 3. */
      const hand = (name: string, piloting: number) => ({
        ...crew,
        id: `crew.test.${name}`,
        name,
        roleTags: ["deckhand"],
        skills: { piloting },
      });
      const hands = [hand("jon", 1), hand("kit", 3), hand("lee", 0), hand("max", 4)];
      const crewTable = Object.fromEntries([crew, ...hands].map((c) => [c.id, c]));
      const crewIds = Object.keys(crewTable);
      const section = (key: string, ...names: string[]) => ({
        key,
        members: names.map((n) => `crew.test.${n}`),
      });

      /** Watch-bill issues (path under `watchBill`, or the no-bill rule) for this scenario. */
      const billIssues = (patch: Record<string, unknown>) =>
        physicalIssues({
          ...bundle,
          crew: crewTable,
          scenarios: { [scenario.id]: { ...scenario, crew: crewIds, ...patch } },
        })
          .filter((i) => i.path.includes("watchBill") || i.message.includes("watch bill"))
          .map((i) => `${i.path.join(".")}: ${i.message}`);

      const AT = "scenarios.scenario.test.default";

      it("accepts a section per watch, each with a qualified helm-stander", () => {
        const watchBill = {
          sections: [
            section("red", "mara", "lee"),
            section("white", "kit"),
            section("blue", "max"),
          ],
          dayworkers: ["crew.test.jon"],
        };
        expect(billIssues({ watchBill })).toEqual([]);
      });

      it("rejects a bill with fewer or more sections than watches a day", () => {
        const two = { sections: [section("red", "mara"), section("white", "kit")], dayworkers: [] };
        expect(billIssues({ watchBill: two })).toEqual([
          `${AT}.watchBill.sections: 2 watch-bill sections for 3 watches a day; each watch needs its section`,
        ]);
        const four = {
          sections: [section("a", "mara"), section("b", "kit"), section("c"), section("d")],
          dayworkers: [],
        };
        expect(billIssues({ watchBill: four })[0]).toContain("4 watch-bill sections for 3");
      });

      it("rejects a section with nobody qualified to stand the helm", () => {
        const watchBill = {
          sections: [section("red", "mara"), section("white", "jon", "lee"), section("blue")],
          dayworkers: ["crew.test.kit"],
        };
        expect(billIssues({ watchBill })).toEqual([
          `${AT}.watchBill.sections.1.members: no qualified helm-stander in section "white" (needs piloting 3)`,
          `${AT}.watchBill.sections.2.members: no qualified helm-stander in section "blue" (needs piloting 3)`,
        ]);
      });

      it("allows no bill for a fixture of at most three crew, and requires one above", () => {
        expect(billIssues({ crew: crewIds.slice(0, 3) })).toEqual([]);
        expect(billIssues({})).toEqual([
          `${AT}.crew: 5 crew and no watch bill: author one (a section per watch, each with a helm-stander, and dayworkers); a generated bill is for fixtures of at most 3 crew`,
        ]);
      });
    });
  });
});
