/**
 * Test fixture for travel + commerce (PLAN §6 W6 "Tests"): 3 core ports with route distances
 * 25/45/70 plus a fourth, `delta`, a spur off `gamma` (50) two hops from `alpha` for voyage
 * tests (passengers-and-galaxy §2.3), one `engine` machine (no power system running these tests, so `actualMode`/`output`
 * are set directly), one `ramp` door, a captain + first officer, two cargo item defs, and the
 * standard price bands. Independent of `core/fixtures/tiny-content.ts` so it can shape the deck
 * exactly (ramp door, engine, two crew spawn points) without touching a fixture other
 * workstreams share.
 */
import {
  FIXTURE_ACTIVITIES,
  FIXTURE_CABINS,
  FIXTURE_DAMAGE,
  FIXTURE_DIRT,
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
} from "../../core/fixtures/ship-life";
import { createKernel } from "../../core/kernel";
import { type KernelRegistry, createRegistry } from "../../core/registry";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type {
  CommandId,
  CrewDefId,
  DeckDefId,
  ItemDefId,
  MachineDefId,
  PortDefId,
  ScenarioDefId,
} from "../../core/types/ids";
import type { EffectiveConfig } from "../../core/types/kernel";
import type { Kernel, World } from "../../core/types/kernel";
import { registerCommerce } from "../commerce";
import { registerTravel } from "./index";

export const PORTS = {
  a: "port.freight.alpha" as PortDefId,
  b: "port.freight.beta" as PortDefId,
  c: "port.freight.gamma" as PortDefId,
  /** Two hops from `a`: the shortest path is a -> c -> d (95), not a -> b -> c -> d (145). */
  d: "port.freight.delta" as PortDefId,
} as const;

export const FIX = {
  deck: "deck.freight.main" as DeckDefId,
  engine: "machine.freight.engine" as MachineDefId,
  crate: "item.freight.crate" as ItemDefId,
  parts: "item.freight.parts" as ItemDefId,
  captain: "crew.freight.captain" as CrewDefId,
  firstOfficer: "crew.freight.mate" as CrewDefId,
  /** The generic passenger template (passengers-and-galaxy §3.5); the id the kernel spawns. */
  passenger: "crew.passenger" as CrewDefId,
  scenario: "scenario.freight" as ScenarioDefId,
} as const;

/**
 * The fixture's ship's day (§the-ships-day). Day knobs are written as `seconds / FIXTURE_DAY` so
 * the values the tests were written against stay visible and the conversion stays exact.
 */
export const FIXTURE_DAY = 1200;

export interface FixtureConfigOverrides {
  /** A fixture convenience in seconds, stored as `narrator.quietTooLongDays`. */
  quietTooLongSeconds?: number;
  dockingFee?: number;
  hookOnEvents?: readonly string[];
  /** §notable-event-hook: `narrator.aftermathHookOnEvents` (none by default). */
  aftermathHookOnEvents?: readonly string[];
  maxCratesPerJob?: number;
  passage?: ConfigDef["commerce"]["passage"];
  /** §limping: `travel.limpSpeedFraction` (0, no limp, by default). */
  limpSpeedFraction?: number;
}

export function fixtureConfig(overrides: FixtureConfigOverrides = {}): ConfigDef {
  return {
    time: { tickRate: 20, daySeconds: FIXTURE_DAY, watchesPerDay: 3 },
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
      hungerPerDay: 0.001 * FIXTURE_DAY,
      fatiguePerDayAwake: 0.001 * FIXTURE_DAY,
      fatiguePerDayWorking: 0.002 * FIXTURE_DAY,
      fatigueRecoveryPerDayAsleep: 0.01 * FIXTURE_DAY,
      comfortPerDay: 0.001 * FIXTURE_DAY,
      comfortRecoveryPerDayResting: 0.01 * FIXTURE_DAY,
      socialPerDay: 0.001 * FIXTURE_DAY,
      socialRecoveryPerDayChatting: 0.01 * FIXTURE_DAY,
      recreationPerDay: 0.001 * FIXTURE_DAY,
      seekThreshold: 0.5,
      mealDays: 10 / FIXTURE_DAY,
      sleepDays: 60 / FIXTURE_DAY,
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
      skillGainPerDay: 0.001 * FIXTURE_DAY,
      workSpeedPerSkillLevel: 0.1,
    },
    urgency: {
      needEssentialAbove: 0.7,
      needSurvivalAbove: 0.9,
      heatContainmentAbove: 0.8,
      heatSurvivalAbove: 0.95,
      routineAgingDays: 60 / FIXTURE_DAY,
      cleaningAgingDays: 60 / FIXTURE_DAY,
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
      // Short, test-friendly durations (seconds); D10: time is a gameplay knob, not a ratio.
      prepareDepartureSeconds: 1,
      undockSeconds: 1,
      departSeconds: 1,
      approachSeconds: 1,
      dockSeconds: 1,
      nominalSpeed: 5,
      staffEstimateSeconds: 0,
      departureMinOutput: 0.5,
      // §limping: no limp unless a test turns it on.
      limpSpeedFraction: overrides.limpSpeedFraction ?? 0,
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
      },
      jobOfferTtlDays: 120 / FIXTURE_DAY,
      dockingFee: overrides.dockingFee ?? 0,
      haulEstimateSeconds: 5,
      reofferDays: 60 / FIXTURE_DAY,
      maxCratesPerJob: overrides.maxCratesPerJob ?? 6,
      passage: overrides.passage ?? {
        ashoreDaysMin: 3 / FIXTURE_DAY,
        ashoreDaysMax: 3 / FIXTURE_DAY,
        overdueDays: 10 / FIXTURE_DAY,
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
    },
    narrator: {
      quietTooLongDays: (overrides.quietTooLongSeconds ?? 600) / FIXTURE_DAY,
      approachHookLeadSeconds: 1,
      maxSpawnsPerCommand: 3,
      maxFaultWindowSeconds: 60,
      spawnBudget: 3,
      faultBudget: 2,
      budgetRefillDays: 600 / FIXTURE_DAY,
      hookOnEvents: overrides.hookOnEvents ?? [],
      aftermathHookOnEvents: overrides.aftermathHookOnEvents ?? [],
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
    // §sections-and-dayworkers: everyone is a dayworker on every watch: always on duty, as before
    // watches.
    watches: fixtureWatches([0, 1, 2]),
    mood: FIXTURE_MOOD,
    hazards: FIXTURE_HAZARDS,
    field: FIXTURE_FIELD,
    damage: FIXTURE_DAMAGE,
    intercom: FIXTURE_INTERCOM,
    galley: FIXTURE_GALLEY,
    dirt: FIXTURE_DIRT,
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

export function fixtureContent(config: ConfigDef = fixtureConfig()): ContentBundle {
  return {
    decks: {
      [FIX.deck]: {
        id: FIX.deck,
        name: "Freight deck",
        width: 8,
        height: 4,
        tiles: ["AAAABBBB", "AAAABBBB", "AAAABBBB", "AAAABBBB"],
        compartments: [
          { key: "hold", symbol: "A", name: "Hold", tags: ["cargoHold"] },
          { key: "engineering", symbol: "B", name: "Engineering", tags: ["engineering"] },
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
        openings: [],
        walls: [],
        machines: [
          { key: "engine1", machineDefId: FIX.engine, origin: { x: 5, y: 1 }, rotation: 0 },
        ],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [
          {
            key: "stowage",
            name: "Cargo stowage",
            tags: ["cargoStowage"],
            tiles: [{ x: 1, y: 2 }],
          },
        ],
        docking: {
          cargoRampDoorKey: "ramp",
          personnelRampDoorKey: "ramp",
          cargoTransferTiles: [{ x: 0, y: 1 }],
          personnelTransferTiles: [{ x: 0, y: 1 }],
        },
        hull: { class: "test_hull", sizeClass: "S", max: 100 },
        spawnPoints: [
          { key: "bunk1", tile: { x: 1, y: 1 }, tags: ["crew"] },
          { key: "bunk2", tile: { x: 2, y: 1 }, tags: ["crew"] },
          { key: "ramp_inside", tile: { x: 0, y: 1 }, tags: ["passenger"] },
        ],
      },
    },
    machines: {
      [FIX.engine]: {
        id: FIX.engine,
        name: "Main Engine",
        tags: ["engine"],
        footprint: [{ x: 0, y: 0 }],
        interactionPositions: [],
        power: { role: "consumer", drawKw: 5, priority: "propulsion", partialPower: "derate" },
        heat: { risePerSecond: 0.01, coolPerSecond: 0.02, derateAbove: 0.8 },
        operation: { requiresOperator: false },
        failure: { baseHazardPerSecond: 0.0001, heatFactor: 2, wearPerSecond: 0.0001 },
        // §departure-gate tests: one derating fault and one symptom-only (overheat) fault. No
        // equipment system runs here, so neither ever fires on its own or changes `output`.
        faults: [
          {
            key: "wornBearing",
            name: "Worn bearing",
            weight: 1,
            effect: { kind: "derate", outputFactor: 0.5 },
            symptom: { key: "vibration", channel: "audible" },
            repair: { steps: [] },
          },
          {
            key: "hotPanel",
            name: "Hot panel",
            weight: 1,
            effect: { kind: "overheat", extraRisePerSecond: 0.01 },
            symptom: { key: "warmPanel", channel: "visual" },
            repair: { steps: [] },
          },
        ],
        components: [],
      },
    },
    items: {
      [FIX.crate]: {
        id: FIX.crate,
        name: "Machine parts crate",
        stacking: "stackable",
        maxStack: 10,
        tags: ["cargo"],
        toolKinds: [],
        mass: 5,
        cargoClass: "general",
      },
      [FIX.parts]: {
        id: FIX.parts,
        name: "Fragile electronics",
        stacking: "stackable",
        maxStack: 5,
        tags: ["cargo", "container"],
        toolKinds: [],
        mass: 2,
        cargoClass: "fragile",
      },
    },
    crew: {
      [FIX.captain]: {
        id: FIX.captain,
        name: "Captain Reyes",
        roleTags: ["captain"],
        skills: { piloting: 6 },
        startingInventory: [],
        bio: "Runs the boat.",
        voice: "Plain and brief.",
      },
      [FIX.firstOfficer]: {
        id: FIX.firstOfficer,
        name: "First Officer Kade",
        roleTags: ["firstOfficer", "engineer"],
        skills: { piloting: 4 },
        startingInventory: [],
        bio: "Backs up the captain.",
        voice: "Plain and brief.",
      },
      [FIX.passenger]: {
        id: FIX.passenger,
        name: "Passenger",
        roleTags: [],
        skills: {},
        startingInventory: [],
        bio: "A paying passenger.",
        voice: "Whoever they turn out to be.",
      },
    },
    traits: {},
    ports: {
      [PORTS.a]: {
        id: PORTS.a,
        name: "Alpha Station",
        setting: "station",
        description: "The home port.",
        character: "The home port.",
        castSeed: [],
        externalStores: [
          { key: "warehouse", name: "Warehouse", kind: "warehouse" },
          { key: "lounge", name: "Lounge", kind: "lounge" },
        ],
        market: [],
        jobTemplates: [
          {
            key: "haulToBeta",
            issuer: "Alpha Freight Co-op",
            toPortId: PORTS.b,
            cargo: [{ itemDefId: FIX.crate, countMin: 1, countMax: 3 }],
            weight: 1,
          },
        ],
        routes: [
          { toPortId: PORTS.b, distance: 25 },
          { toPortId: PORTS.c, distance: 45 },
        ],
      },
      [PORTS.b]: {
        id: PORTS.b,
        name: "Beta Yard",
        setting: "station",
        description: "A midway yard.",
        character: "A midway yard.",
        castSeed: [],
        externalStores: [
          { key: "warehouse", name: "Warehouse", kind: "warehouse" },
          { key: "lounge", name: "Lounge", kind: "lounge" },
        ],
        market: [],
        jobTemplates: [],
        routes: [
          { toPortId: PORTS.a, distance: 25 },
          { toPortId: PORTS.c, distance: 70 },
        ],
      },
      [PORTS.c]: {
        id: PORTS.c,
        name: "Gamma Ring",
        setting: "station",
        description: "The far ring.",
        character: "The far ring.",
        castSeed: [],
        externalStores: [
          { key: "warehouse", name: "Warehouse", kind: "warehouse" },
          { key: "lounge", name: "Lounge", kind: "lounge" },
        ],
        market: [],
        jobTemplates: [],
        routes: [
          { toPortId: PORTS.a, distance: 45 },
          { toPortId: PORTS.b, distance: 70 },
          { toPortId: PORTS.d, distance: 50 },
        ],
      },
      [PORTS.d]: {
        id: PORTS.d,
        name: "Delta Spur",
        setting: "station",
        description: "A spur beyond the ring.",
        character: "A spur beyond the ring.",
        castSeed: [],
        externalStores: [
          { key: "warehouse", name: "Warehouse", kind: "warehouse" },
          { key: "lounge", name: "Lounge", kind: "lounge" },
        ],
        market: [],
        jobTemplates: [],
        routes: [{ toPortId: PORTS.c, distance: 50 }],
      },
    },
    scenarios: {
      [FIX.scenario]: {
        id: FIX.scenario,
        name: "Freight",
        deckId: FIX.deck,
        startPortId: PORTS.a,
        crew: [FIX.captain, FIX.firstOfficer],
        startingMoney: 100,
        startingItems: [],
        initialFaults: [],
        watchBill: { sections: [], dayworkers: [FIX.captain, FIX.firstOfficer] },
      },
    },
    thoughts: FIXTURE_THOUGHTS,
    activities: FIXTURE_ACTIVITIES,
    topics: FIXTURE_TOPICS,
    config,
    hash: "fixture-content-v1",
  };
}

export function fixtureEffectiveConfig(config: ConfigDef = fixtureConfig()): EffectiveConfig {
  return { values: config, hash: "fixture-config" };
}

export interface FixtureWorld {
  readonly registry: KernelRegistry;
  readonly kernel: Kernel;
  readonly world: World;
}

export function freightTestWorld(overrides: FixtureConfigOverrides = {}): FixtureWorld {
  const registry = createRegistry();
  registerTravel(registry);
  registerCommerce(registry);
  const kernel = createKernel(registry);
  const config = fixtureConfig(overrides);
  const world = kernel.createWorld(
    FIX.scenario,
    42,
    fixtureContent(config),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/**
 * Test helper: advance up to `ticks`, transparently acknowledging any hooks raised along the way
 * (e.g. `captainAshore` firing on arrival at a port with no job templates) so a test can drive travel
 * without reacting to every incidental hook. Stops early on a `decision` halt (the caller must
 * resolve it) or once `ticks` is exhausted.
 */
/**
 * Test helper: advance one tick at a time, acknowledging hooks, until travel is in `stage`
 * (`approachingPort` no longer exists). Throws on a decision halt or
 * when `maxTicks` runs out, so a test never silently checks the wrong moment.
 */
export function advanceToStage(
  kernel: Kernel,
  world: World,
  stage: World["state"]["travel"]["stage"],
  maxTicks = 5_000,
): void {
  for (let i = 0; i < maxTicks; i++) {
    if (world.state.travel.stage === stage) return;
    const result = advanceThroughHooks(kernel, world, 1);
    if (result.halt.kind === "decision") throw new Error(`decision halt before stage ${stage}`);
  }
  if (world.state.travel.stage !== stage) throw new Error(`never reached stage ${stage}`);
}

export function advanceThroughHooks(kernel: Kernel, world: World, ticks: number) {
  let remaining = ticks;
  for (;;) {
    const result = kernel.advance(world, remaining);
    remaining -= result.ticksAdvanced;
    if (result.halt.kind !== "hook" || remaining <= 0) return result;
    const hookId = world.state.narrator.pendingHook?.id;
    if (hookId === undefined) return result;
    kernel.enqueueCommand(world, {
      id: `cmd:ack:${hookId}` as CommandId,
      source: "system",
      kind: "acknowledgeHook",
      payload: { hookId },
    });
  }
}
