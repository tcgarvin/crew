/**
 * World creation and `advance` (SD §19.1). `createWorld` builds an empty `WorldState`,
 * instantiates the scenario deck, then spawns crew, stores and faults through the command path,
 * then assigns berths and sets personal belongings down in lockers (D74).
 */
import { assignBerths, stowPersonalItems } from "./berths";
import { emptyCaches, rebuildCaches } from "./caches";
import { configTicks } from "./clock";
import { type ApplyCtx, applyCommandNow } from "./commands";
import { headNeedingNarration } from "./decisions";
import { createDefLookup } from "./defs";
import { dockForPort } from "./docks";
import { createEventBuffer } from "./events";
import { allocateId, initialIdCounters } from "./ids";
import { dressDock } from "./locals";
import { marketSeed } from "./markets";
import { runStep } from "./pipeline";
import type { KernelRegistry } from "./registry";
import { isTickerEvent } from "./render";
import { createRngApi, seedAllStreams } from "./rng";
import type { Command, ScenarioSpawn } from "./types/commands";
import type { PhysicalLocation, TileCoord } from "./types/common";
import type { ConfigDef, ContentBundle, DeckDef, ScenarioDef } from "./types/content";
import type { SimEvent } from "./types/events";
import type {
  CommandId,
  CompartmentId,
  DeckDefId,
  LocalKey,
  MachineId,
  PortDefId,
  ScenarioDefId,
  TempRef,
} from "./types/ids";
import type { AdvanceHalt, AdvanceResult, EffectiveConfig, World } from "./types/kernel";
import type { RngApi } from "./types/pipeline";
import type { Machine } from "./types/ship";
import { SCHEMA_VERSION, type WorldState } from "./types/state";

function emptyState(scenario: ScenarioDef, seed: number): WorldState {
  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: scenario.id,
    seed,
    tick: 0,
    rng: seedAllStreams(seed),
    nextId: initialIdCounters(),
    actors: {},
    compartments: {},
    deck: { tiles: {}, geometryRevision: 0 },
    doors: {},
    machines: {},
    power: { domains: {} },
    items: {},
    berths: {},
    work: { problems: {}, tasks: {}, claims: {}, plannerRotation: 0 },
    travel: { stage: "docked", portId: scenario.startPortId },
    jobs: {},
    money: { balance: 0, transactions: {} },
    markets: {},
    dockside: { locals: {}, props: [] },
    decisions: { records: {}, queue: [], held: [] },
    narrator: {
      lastNarrativeTick: 0,
      budget: { spawnsRemaining: 0, faultsRemaining: 0 },
      recentHookIds: [],
    },
    commands: { queue: [], recentIds: [], nextSeq: 1 },
    defs: { dynamic: { items: {}, crew: {} } },
  };
}

/**
 * The ship's deck: the one deck instantiated in state (`state.deck.tiles` has a key per deck
 * `createWorld` built). The bundle may hold several decks (other footprints); the scenario's is
 * the only one in the world. Throws on none or several, which world creation rules out.
 */
export function shipDeckId(state: { readonly deck: Pick<WorldState["deck"], "tiles"> }): DeckDefId {
  const ids = Object.keys(state.deck.tiles) as DeckDefId[];
  const [only] = ids;
  if (only === undefined || ids.length !== 1) {
    throw new Error(`Expected exactly one ship deck in state, found ${ids.length}`);
  }
  return only;
}

/**
 * Instantiate the deck's compartments, doors, machines and power domains.
 *
 * W2 decision: ship structure comes from the `DeckDef`, not spawn commands (the scenario command
 * vocabulary only spawns actors and items). Machines start `on` at full output, fresh, at
 * ambient temperature, with the failure threshold drawn from the `failures` stream as a unit
 * exponential (SD §9.2); batteries start full. Power and equipment (W5) refine these on their
 * first run.
 */
function instantiateDeck(state: WorldState, deck: DeckDef, content: ContentBundle, rng: RngApi) {
  state.deck.tiles[deck.id] = {};
  for (const def of deck.compartments) {
    const id = allocateId(state, "compartment");
    state.compartments[id] = { id, deckId: deck.id, key: def.key };
  }
  for (const def of deck.doors) {
    const id = allocateId(state, "door");
    state.doors[id] = {
      id,
      deckId: deck.id,
      placementKey: def.key,
      kind: def.kind,
      physicalState: def.initialState,
      requestedState: def.initialState,
      transitionProgress: 0,
      integrity: 1,
      sealQuality: 1,
      actuatorFault: false,
      manualOperationSupported: def.manualOperationSupported,
      occupants: [],
    };
  }
  for (const placement of deck.machines) {
    const def = content.machines[placement.machineDefId];
    if (def === undefined) {
      throw new Error(`Deck "${deck.id}" places unknown machine "${placement.machineDefId}"`);
    }
    const id = allocateId(state, "machine");
    const machine: Machine = {
      id,
      defId: def.id,
      deckId: deck.id,
      placementKey: placement.key,
      integrity: 1,
      condition: 1,
      desiredMode: "on",
      actualMode: "on",
      output: 1,
      powerAllocatedKw: 0,
      temperature: 0,
      faults: [],
      scheduledFaults: [],
      failure: { accumulatedHazard: 0, threshold: -Math.log(1 - rng.float("failures")) },
      lastMaintainedTick: 0,
      maintenanceProgress: 0,
      roleState:
        def.power.role === "battery"
          ? { role: "battery", storedKj: def.power.capacityKj }
          : { role: "none" },
    };
    state.machines[id] = machine;
  }
  for (const domain of deck.powerDomains) {
    state.power.domains[domain.key] = {
      key: domain.key,
      supplyKw: 0,
      demandKw: 0,
      batteryFlowKw: 0,
      tripped: false,
    };
  }
}

const centre = (tile: TileCoord) => ({ x: tile.x + 0.5, y: tile.y + 0.5 });

/**
 * The scenario's setup commands. W2 decision: crew take `crew` spawn points in order, wrapping if
 * there are more crew than points; starting inventory is carried; loose stores are placed on
 * their zone's tiles round-robin, stackables split into `maxStack` chunks and uniques one each.
 */
function scenarioSetupCommands(
  scenario: ScenarioDef,
  deck: DeckDef,
  content: ContentBundle,
  state: WorldState,
): Command[] {
  const commandId = (n: number) => `cmd:scenario:${scenario.id}:${n}` as CommandId;
  const spawns: ScenarioSpawn[] = [];
  let refCounter = 0;
  const nextRef = (): TempRef => `$s${++refCounter}`;
  const itemSpawns = (defId: ScenarioDef["startingItems"][number]["itemDefId"], count: number) => {
    const def = content.items[defId];
    if (def === undefined) throw new Error(`Scenario "${scenario.id}": unknown item "${defId}"`);
    const chunk = def.stacking === "unique" ? 1 : def.maxStack;
    const counts: number[] = [];
    for (let left = count; left > 0; left -= chunk) counts.push(Math.min(chunk, left));
    return counts;
  };

  const crewPoints = deck.spawnPoints.filter((p) => p.tags.includes("crew"));
  if (scenario.crew.length > 0 && crewPoints.length === 0) {
    throw new Error(`Deck "${deck.id}" has no crew spawn points`);
  }
  scenario.crew.forEach((crewDefId, index) => {
    const point = crewPoints[index % crewPoints.length];
    if (point === undefined) throw new Error("unreachable: no crew spawn point");
    const actorRef = nextRef();
    spawns.push({
      kind: "actor",
      tempRef: actorRef,
      crewDefId,
      location: { kind: "onDeck", deckId: deck.id, ...centre(point.tile) },
    });
    const crewDef = content.crew[crewDefId];
    for (const line of crewDef?.startingInventory ?? []) {
      for (const count of itemSpawns(line.itemDefId, line.count)) {
        spawns.push({
          kind: "item",
          tempRef: nextRef(),
          itemDefId: line.itemDefId,
          count,
          // Resolved to the new actor's ID at apply time (see command-handlers `checkLocation`).
          location: { kind: "carriedBy", actorId: actorRef as unknown as never },
        });
      }
    }
  });

  for (const stores of scenario.startingItems) {
    const zone = deck.zones.find((z) => z.key === stores.zoneKey);
    if (zone === undefined || zone.tiles.length === 0) {
      throw new Error(`Scenario "${scenario.id}": zone "${stores.zoneKey}" missing or empty`);
    }
    itemSpawns(stores.itemDefId, stores.count).forEach((count, index) => {
      const tile = zone.tiles[index % zone.tiles.length] as TileCoord;
      const location: PhysicalLocation = { kind: "onDeck", deckId: deck.id, ...centre(tile) };
      spawns.push({
        kind: "item",
        tempRef: nextRef(),
        itemDefId: stores.itemDefId,
        count,
        location,
      });
    });
  }

  const commands: Command[] = [];
  if (spawns.length > 0) {
    commands.push({
      id: commandId(commands.length),
      source: "scenario",
      kind: "scenarioSpawn",
      payload: { spawns },
    });
  }
  const machineByPlacement = new Map<LocalKey, MachineId>(
    Object.values(state.machines).map((m) => [m.placementKey, m.id]),
  );
  for (const fault of scenario.initialFaults) {
    const machineId = machineByPlacement.get(fault.placementKey);
    if (machineId === undefined) {
      throw new Error(`Scenario "${scenario.id}": no machine placement "${fault.placementKey}"`);
    }
    commands.push({
      id: commandId(commands.length),
      source: "scenario",
      kind: "scenarioInjectFault",
      payload: { machineId, faultKey: fault.faultKey },
    });
  }
  return commands;
}

/**
 * Integration 2: spawned crew start with needs drawn from `config.needs.initialRange` on the
 * `setup` stream (in actor-key order), so the first minutes have motion rather than everyone
 * idling at zero deficit. A degenerate range (min = max) consumes no draw.
 */
function seedInitialNeeds(
  state: WorldState,
  ranges: ConfigDef["needs"]["initialRange"],
  rng: RngApi,
): void {
  const keys = ["hunger", "fatigue", "comfort", "social"] as const;
  for (const actor of Object.values(state.actors)) {
    if (!actor.crew) continue;
    for (const key of keys) {
      const { min, max } = ranges[key];
      actor.needs[key] = max > min ? min + (max - min) * rng.float("setup") : min;
    }
  }
}

/** D47: every port's market opens at its content position; purchases and `stockMarket` move it. */
function seedMarkets(state: WorldState, content: ContentBundle): void {
  for (const port of Object.values(content.ports)) {
    state.markets[port.id] = marketSeed(port);
  }
}

export function createWorld(
  registry: KernelRegistry,
  scenarioId: ScenarioDefId,
  seed: number,
  content: ContentBundle,
  config: EffectiveConfig,
): World {
  const scenario = content.scenarios[scenarioId];
  if (scenario === undefined) throw new Error(`Unknown scenario "${scenarioId}"`);
  const deck = content.decks[scenario.deckId];
  if (deck === undefined) throw new Error(`Scenario "${scenarioId}": unknown deck`);
  if (content.ports[scenario.startPortId] === undefined) {
    throw new Error(`Scenario "${scenarioId}": unknown start port "${scenario.startPortId}"`);
  }
  if (!Number.isInteger(scenario.startingMoney) || scenario.startingMoney < 0) {
    throw new Error(`Scenario "${scenarioId}": startingMoney must be a nonnegative integer`);
  }

  const state = emptyState(scenario, seed);
  seedMarkets(state, content);
  const values = config.values;
  state.narrator.budget = {
    spawnsRemaining: values.narrator.spawnBudget,
    faultsRemaining: values.narrator.faultBudget,
  };
  const world: World = { state, caches: emptyCaches(), content, config };
  const rng = createRngApi(state);
  instantiateDeck(state, deck, content, rng);
  startAlongside(state, deck, content, scenario.startPortId);

  if (scenario.startingMoney > 0) {
    const id = allocateId(state, "transaction");
    state.money.balance = scenario.startingMoney;
    state.money.transactions[id] = {
      id,
      tick: 0,
      amount: scenario.startingMoney,
      reason: "scenario",
    };
  }

  // Setup runs through the normal validate/apply path at tick 0; its events are discarded.
  const buffer = createEventBuffer();
  const ctx: ApplyCtx = {
    state,
    caches: world.caches,
    content,
    defs: createDefLookup(content, state),
    config: values,
    rng,
    tick: 0,
    emit: buffer.emit,
  };
  for (const command of scenarioSetupCommands(scenario, deck, content, state)) {
    applyCommandNow(registry, ctx, command);
  }
  // D74: berths by rank from tick 0, and each crew member's belongings in their locker.
  assignBerths(state, deck, content);
  stowPersonalItems(state, deck, content);
  seedInitialNeeds(state, values.needs.initialRange, rng);
  // D66: the dock a game starts alongside has its regulars at their posts from tick 0.
  if (state.deck.dock !== undefined) {
    dressDock(state, content, undefined, 0, configTicks(values, values.travel.localShuffleSeconds));
  }
  rebuildCaches(world, registry);
  return world;
}

/**
 * D61: a scenario starts docked, so its port's dock (if content has one) is alongside from tick
 * 0, ramps already down, since docked means ramps down (D59). Set in state before any cache
 * exists; the nav cache builder grafts it.
 */
function startAlongside(
  state: WorldState,
  deck: DeckDef,
  content: ContentBundle,
  portId: PortDefId,
): void {
  const dock = dockForPort(content, portId);
  if (dock === undefined) return;
  state.deck.dock = { dockId: dock.id, deckId: deck.id };
  for (const door of Object.values(state.doors)) {
    if (door.deckId !== deck.id || door.kind !== "ramp") continue;
    door.physicalState = "open";
    door.requestedState = "open";
  }
}

// ---------------------------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------------------------

const COMPLETED: AdvanceHalt = { kind: "completed" };

/**
 * Why the world cannot run its next tick, or `null` if it can. W2 decision: a pending
 * hook/decision halts unless its `acknowledgeHook`/`resolveDecision` is already queued for the
 * next tick; that tick then runs and phase 1 applies it. A hook outranks a decision.
 *
 * D37: a policy decision that has not had its `policyDecision` hook yet does not halt the world
 * by itself; the next tick runs so phase 8 can raise the hook (the only way the head can lack
 * one is that another hook was pending when it reached the head), and the hook halt comes
 * first. The host therefore always sees `hook` before `decision` for a policy card.
 */
export function haltReason(state: WorldState): AdvanceHalt | null {
  const nextTick = state.tick + 1;
  const queuedDue = (predicate: (command: Command) => boolean) =>
    state.commands.queue.some((c) => c.applyAtTick <= nextTick && predicate(c));
  const hook = state.narrator.pendingHook;
  if (
    hook !== undefined &&
    !queuedDue((c) => c.kind === "acknowledgeHook" && c.payload.hookId === hook.id)
  ) {
    return { kind: "hook" };
  }
  const head = state.decisions.queue[0];
  if (
    head !== undefined &&
    headNeedingNarration(state) === undefined &&
    !queuedDue((c) => c.kind === "resolveDecision" && c.payload.decisionId === head)
  ) {
    return { kind: "decision" };
  }
  return null;
}

/** Halt after a completed tick: anything pending stops the run (D37: a hook first). */
function haltAfterStep(state: WorldState): AdvanceHalt | null {
  if (state.narrator.pendingHook !== undefined) return { kind: "hook" };
  if (state.decisions.queue.length > 0 && headNeedingNarration(state) === undefined) {
    return { kind: "decision" };
  }
  return null;
}

/**
 * Run up to `ticks` steps. Returns immediately while halted; otherwise stops after the tick that
 * raises a hook or leaves a decision pending. W2 decision: `caches.diagnostics.lastEvents` gets
 * this call's ticker events for the render ticker (`isTickerEvent`: `notable`+ plus a few
 * readable trace types), the latest `config.events.tickerMaxEntries` of them; empty when halted.
 */
export function advance(world: World, registry: KernelRegistry, ticks: number): AdvanceResult {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`advance: ticks must be a nonnegative integer, got ${ticks}`);
  }
  const events: SimEvent[] = [];
  let ticksAdvanced = 0;
  let halt: AdvanceHalt = haltReason(world.state) ?? COMPLETED;
  while (halt.kind === "completed" && ticksAdvanced < ticks) {
    events.push(...runStep(world, registry));
    ticksAdvanced += 1;
    halt = haltAfterStep(world.state) ?? COMPLETED;
  }
  const notable = events.filter(isTickerEvent);
  const cap = world.config.values.events.tickerMaxEntries;
  world.caches.diagnostics.lastEvents = notable.slice(Math.max(0, notable.length - cap));
  return { events, ticksAdvanced, halt };
}

/** Compartment instance by deck key, for tests and setup helpers. */
export function compartmentByKey(state: WorldState, key: LocalKey): CompartmentId | undefined {
  return Object.values(state.compartments).find((c) => c.key === key)?.id;
}
