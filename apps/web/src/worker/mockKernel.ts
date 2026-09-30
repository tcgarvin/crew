/**
 * A `Kernel` implementation that fabricates plausible frames instead of running the real
 * simulation. Built so that swapping it for the real `@crew/sim` kernel is a one-line change in
 * `sim.worker.ts` — every other file (`host.ts`, `host/playback.ts`, the UI) depends only on the
 * `Kernel`/`ToWorker`/`FromWorker` contracts from `@crew/sim`.
 *
 * What it fakes:
 * - 8 actors wandering between the waypoints in `mockGeometry.ts`, cycling `actionLabel`.
 * - 1 machine flipping ok -> degraded -> failed -> ok on a timer.
 * - A ticker line every few sim-seconds.
 * - Every ~40 sim-seconds: a `NarratorHook`, then (once acknowledged) a `Decision`.
 *
 * `WorldState` is used for real (not a shortcut struct) so the protocol messages are exactly what
 * the real kernel will eventually send. Bookkeeping that has no place in `WorldState` (waypoint
 * targets, machine cycle phase, narrator/decision timers) lives in a side table keyed by object
 * identity — analogous to `DerivedCaches` (never serialized, rebuilt on restore).
 */
import type {
  Actor,
  ActorId,
  AdvanceResult,
  AgentView,
  Command,
  CompartmentId,
  ConfigDef,
  ContentBundle,
  DecisionCardSpec,
  DecisionId,
  EffectiveConfig,
  EnqueueResult,
  HookId,
  Kernel,
  MachineDefId,
  MachineId,
  PortDefId,
  RenderFrame,
  RenderMachineState,
  SaveEnvelope,
  ScenarioDefId,
  SimEvent,
  TickerEntry,
  World,
  WorldState,
} from "@crew/sim";
import { SCHEMA_VERSION, SIM_VERSION } from "@crew/sim";
import { at } from "./arrayUtils";
import {
  MOCK_ACTION_LABELS,
  MOCK_COMPARTMENTS,
  MOCK_DECK_ID,
  MOCK_DOORS,
  MOCK_MACHINES,
  MOCK_WAYPOINTS,
} from "./mockGeometry";

/** Ticks per sim-second for the mock, matching the kernel default (SD §5.1). */
export const MOCK_TICK_RATE = 20;

const MOCK_PORT_ID = "port.mock.home" as PortDefId;

const ACTOR_NAMES = [
  "Mara Voss",
  "Jonno Pell",
  "Iri Cade",
  "Deke Osu",
  "Sela Ptarn",
  "Row Bantha",
  "Nix Farrow",
  "Wexa Thorn",
];

const ACTOR_SPEED_TILES_PER_SEC = 1.6;
const MACHINE_STAGE_TICKS = MOCK_TICK_RATE * 14; // ~14s per machine state
const TICKER_EVERY_TICKS = MOCK_TICK_RATE * 6; // ~6s
const HOOK_EVERY_TICKS = MOCK_TICK_RATE * 40; // ~40s

const TICKER_LINES = [
  "Coolant pump humming along.",
  "Someone left the galley a mess again.",
  "Cargo netting checked and secure.",
  "A meteor ping registered on the hull sensors.",
  "Quiet shift on the bridge.",
  "Engineering reports nominal power draw.",
];

const MACHINE_CYCLE: readonly RenderMachineState[] = ["ok", "degraded", "failed", "ok"];

interface MockActorBookkeeping {
  targetIndex: number;
  dwellUntilTick: number;
  actionLabel: string;
}

/** Non-serialized simulation bookkeeping, side-tabled by `WorldState` identity. */
interface MockBookkeeping {
  actors: Record<ActorId, MockActorBookkeeping>;
  machineStageStartTick: Record<MachineId, number>;
  nextTickerTick: number;
  nextHookTick: number;
  pendingTicker: TickerEntry[];
  money: number;
}

const bookkeepingByState = new WeakMap<WorldState, MockBookkeeping>();

function rand(seed: { value: number }): number {
  // Small deterministic-enough LCG so re-renders within a session are stable; not cryptographic,
  // not the kernel's sfc32 (D4: determinism is not a goal for the mock either).
  seed.value = (seed.value * 1664525 + 1013904223) >>> 0;
  return seed.value / 0xffffffff;
}

function makeActorId(i: number): ActorId {
  return `a${i + 1}` as ActorId;
}

function pickWaypointIndex(seed: { value: number }, exclude: number): number {
  let idx = Math.floor(rand(seed) * MOCK_WAYPOINTS.length);
  if (idx === exclude) {
    idx = (idx + 1) % MOCK_WAYPOINTS.length;
  }
  return idx;
}

function buildInitialWorldState(scenarioId: ScenarioDefId, seed: number): WorldState {
  const seedState = { value: (seed || 1) >>> 0 };
  const actors: Record<ActorId, Actor> = {};
  const bookkeeping: MockBookkeeping = {
    actors: {},
    machineStageStartTick: {},
    nextTickerTick: TICKER_EVERY_TICKS,
    nextHookTick: HOOK_EVERY_TICKS,
    pendingTicker: [],
    money: 1200,
  };

  for (let i = 0; i < ACTOR_NAMES.length; i++) {
    const id = makeActorId(i);
    const wp = at(MOCK_WAYPOINTS, i % MOCK_WAYPOINTS.length);
    actors[id] = {
      id,
      defId: `crew.mock_${i}` as Actor["defId"],
      name: ACTOR_NAMES[i] ?? `Crew ${i + 1}`,
      roleTags: i === 0 ? ["captain"] : i === 1 ? ["firstOfficer", "engineer"] : ["deckhand"],
      location: { kind: "onDeck", deckId: MOCK_DECK_ID, x: wp.x, y: wp.y },
      movement: { kind: "stationary" },
      facing: 0,
      needs: { hunger: 0.2, fatigue: 0.2, comfort: 0.1, social: 0.2 },
      capacities: { movement: 1, manipulation: 1, consciousness: 1 },
      skills: {},
      traits: [],
      mood: 0,
      schedule: { shiftKey: "alpha" },
      activity: {
        kind: "personal",
        activity: "wander",
        urgency: "voluntaryActivity",
        action: {
          kind: "wait",
          stage: "waiting",
          progress: 0,
          startedTick: 0,
          interruptible: true,
        },
        sinceTick: 0,
      },
      lastPlannedTick: 0,
      knowledge: {},
      navigationKnowledgeRevision: 0,
      availability: "available",
      crew: true,
    };
    bookkeeping.actors[id] = {
      targetIndex: i % MOCK_WAYPOINTS.length,
      dwellUntilTick: 0,
      actionLabel: at(MOCK_ACTION_LABELS, i % MOCK_ACTION_LABELS.length),
    };
  }

  for (const m of MOCK_MACHINES) {
    bookkeeping.machineStageStartTick[m.id] = 0;
  }

  const compartments: WorldState["compartments"] = {};
  MOCK_COMPARTMENTS.forEach((c, i) => {
    const id = `c${i + 1}` as CompartmentId;
    compartments[id] = { id, deckId: MOCK_DECK_ID, key: c.id };
  });

  const doors: WorldState["doors"] = {};
  for (const d of MOCK_DOORS) {
    doors[d.id] = {
      id: d.id,
      deckId: MOCK_DECK_ID,
      placementKey: d.id,
      kind: "interior",
      physicalState: "closed",
      requestedState: "closed",
      transitionProgress: 0,
      integrity: 1,
      sealQuality: 1,
      actuatorFault: false,
      manualOperationSupported: true,
      occupants: [],
    };
  }

  const machines: WorldState["machines"] = {};
  for (const m of MOCK_MACHINES) {
    machines[m.id] = {
      id: m.id,
      defId: "machine.coolant_pump.mk1" as MachineDefId,
      deckId: MOCK_DECK_ID,
      placementKey: m.id,
      integrity: 1,
      condition: 1,
      desiredMode: "on",
      actualMode: "on",
      output: 1,
      powerAllocatedKw: 4,
      temperature: 0.3,
      faults: [],
      scheduledFaults: [],
      failure: { accumulatedHazard: 0, threshold: 0.8 },
      lastMaintainedTick: 0,
      roleState: { role: "none" },
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId,
    seed,
    tick: 0,
    rng: {
      setup: [1, 2, 3, 4],
      failures: [5, 6, 7, 8],
      perception: [9, 10, 11, 12],
      social: [13, 14, 15, 16],
      commerce: [17, 18, 19, 20],
      narrator: [21, 22, 23, 24],
    },
    nextId: {
      actor: ACTOR_NAMES.length + 1,
      machine: MOCK_MACHINES.length + 1,
      item: 1,
      door: MOCK_DOORS.length + 1,
      compartment: MOCK_COMPARTMENTS.length + 1,
      task: 1,
      problem: 1,
      job: 1,
      decision: 1,
      hook: 1,
      claim: 1,
      transaction: 1,
      event: 1,
    },
    actors,
    compartments,
    deck: { tiles: {}, geometryRevision: 1 },
    doors,
    machines,
    power: {
      domains: {
        main: { key: "main", supplyKw: 20, demandKw: 8, batteryFlowKw: 0, tripped: false },
      },
    },
    items: {},
    work: { problems: {}, tasks: {}, claims: {}, plannerRotation: 0 },
    travel: { stage: "docked", portId: MOCK_PORT_ID },
    jobs: {},
    money: { balance: bookkeeping.money, transactions: {} },
    decisions: { records: {}, queue: [] },
    narrator: {
      lastNarrativeTick: 0,
      budget: { spawnsRemaining: 3, faultsRemaining: 3 },
      recentHookIds: [],
    },
    commands: { queue: [], recentIds: [], nextSeq: 1 },
    defs: { dynamic: { items: {}, crew: {} } },
  } satisfies WorldState;
}

function bookkeepingFor(state: WorldState): MockBookkeeping {
  const existing = bookkeepingByState.get(state);
  if (existing) return existing;
  // Restored from a save: rebuild fresh bookkeeping from current positions.
  const rebuilt: MockBookkeeping = {
    actors: {},
    machineStageStartTick: {},
    nextTickerTick: state.tick + TICKER_EVERY_TICKS,
    nextHookTick: state.tick + HOOK_EVERY_TICKS,
    pendingTicker: [],
    money: state.money.balance,
  };
  const ids = Object.keys(state.actors) as ActorId[];
  ids.forEach((id, i) => {
    rebuilt.actors[id] = {
      targetIndex: i % MOCK_WAYPOINTS.length,
      dwellUntilTick: state.tick,
      actionLabel: at(MOCK_ACTION_LABELS, i % MOCK_ACTION_LABELS.length),
    };
  });
  for (const m of MOCK_MACHINES) {
    rebuilt.machineStageStartTick[m.id] = state.tick;
  }
  bookkeepingByState.set(state, rebuilt);
  return rebuilt;
}

function stepActor(
  state: WorldState,
  bk: MockActorBookkeeping,
  actor: Actor,
  seedState: { value: number },
  tick: number,
): void {
  if (actor.location.kind !== "onDeck") return;
  if (tick < bk.dwellUntilTick) {
    return;
  }
  const target = at(MOCK_WAYPOINTS, bk.targetIndex);
  const dx = target.x - actor.location.x;
  const dy = target.y - actor.location.y;
  const dist = Math.hypot(dx, dy);
  const step = ACTOR_SPEED_TILES_PER_SEC / MOCK_TICK_RATE;
  if (dist < step) {
    // Arrived: dwell, then pick a new waypoint and label.
    actor.location = { kind: "onDeck", deckId: MOCK_DECK_ID, x: target.x, y: target.y };
    bk.targetIndex = pickWaypointIndex(seedState, bk.targetIndex);
    bk.actionLabel = at(
      MOCK_ACTION_LABELS,
      Math.floor(rand(seedState) * MOCK_ACTION_LABELS.length),
    );
    bk.dwellUntilTick =
      tick + Math.floor(rand(seedState) * MOCK_TICK_RATE * 6) + MOCK_TICK_RATE * 2;
    actor.facing = Math.atan2(dy, dx);
  } else {
    const nx = actor.location.x + (dx / dist) * step;
    const ny = actor.location.y + (dy / dist) * step;
    actor.location = { kind: "onDeck", deckId: MOCK_DECK_ID, x: nx, y: ny };
    actor.facing = Math.atan2(dy, dx);
    bk.actionLabel = "walking";
  }
}

function machineStateAt(tick: number, startTick: number): RenderMachineState {
  const elapsed = tick - startTick;
  const stageIndex = Math.floor(elapsed / MACHINE_STAGE_TICKS) % (MACHINE_CYCLE.length - 1);
  return at(MACHINE_CYCLE, stageIndex);
}

/**
 * Fabricated "narrator response" — in the real system this is what the server returns for a
 * `jobBoard` hook. `host.ts` enqueues a `surfaceDecision` command built from this after its fake
 * 2s narrator delay, then acknowledges the hook, exactly like the real flow would.
 */
export function mockDecisionCard(): DecisionCardSpec {
  return {
    prompt: {
      key: "decision.mock.jobOffer",
      params: {},
      prose:
        "A courier at the ramp offers a small freight contract, but your schedule is already tight. Take it?",
    },
    left: { label: { key: "decision.accept", params: {} }, commands: [] },
    right: { label: { key: "decision.decline", params: {} }, commands: [] },
  };
}

export const MOCK_CONTENT_BUNDLE: ContentBundle = {
  decks: {},
  machines: {},
  items: {},
  crew: {},
  traits: {},
  ports: {},
  scenarios: {},
  // The mock never reads config through content; `EffectiveConfig` below carries what the host
  // uses (tickRate). Cast: a full `ConfigDef` has ~10 tuning sections (see content.ts) irrelevant
  // to a fabricated world.
  config: { time: { tickRate: MOCK_TICK_RATE } } as unknown as ConfigDef,
  hash: "mock-content",
};

export const MOCK_CONFIG: EffectiveConfig = {
  values: { time: { tickRate: MOCK_TICK_RATE } } as unknown as ConfigDef,
  hash: "mock-config",
};

export const mockKernel: Kernel = {
  createWorld(scenarioId, seed): World {
    const state = buildInitialWorldState(scenarioId, seed);
    bookkeepingByState.set(state, bookkeepingFor(state));
    return {
      state,
      // Never read by the mock; typed as `never` fields would fight the real `DerivedCaches`
      // shape for no benefit, so this is an intentionally empty stand-in.
      caches: {
        dirty: { navigation: false, power: false, inventory: false },
        nav: { geometryRevision: 0, edgeMask: {} },
        index: {} as World["caches"]["index"],
        diagnostics: {} as World["caches"]["diagnostics"],
      },
      content: MOCK_CONTENT_BUNDLE,
      config: MOCK_CONFIG,
    };
  },

  advance(world, ticks): AdvanceResult {
    const { state } = world;
    const bk = bookkeepingFor(state);
    const events: SimEvent[] = [];
    const seedState = { value: (state.seed + state.tick + 1) >>> 0 };

    if (state.narrator.pendingHook) {
      return { events, ticksAdvanced: 0, halt: { kind: "hook" } };
    }
    if (state.decisions.queue.length > 0) {
      return { events, ticksAdvanced: 0, halt: { kind: "decision" } };
    }

    let advanced = 0;
    for (; advanced < ticks; advanced++) {
      state.tick += 1;

      for (const actor of Object.values(state.actors)) {
        const abk = bk.actors[actor.id];
        if (abk) stepActor(state, abk, actor, seedState, state.tick);
      }

      if (state.tick >= bk.nextTickerTick) {
        bk.nextTickerTick = state.tick + TICKER_EVERY_TICKS;
        const line = at(TICKER_LINES, Math.floor(rand(seedState) * TICKER_LINES.length));
        bk.pendingTicker.push({ tick: state.tick, text: line, significance: "notable" });
        bk.money += 5;
        state.money = { ...state.money, balance: bk.money };
      }

      if (state.tick >= bk.nextHookTick) {
        bk.nextHookTick = state.tick + HOOK_EVERY_TICKS;
        const hookId = `k${state.nextId.hook}` as HookId;
        state.nextId = { ...state.nextId, hook: state.nextId.hook + 1 };
        state.narrator = {
          ...state.narrator,
          pendingHook: {
            id: hookId,
            kind: "jobBoard",
            context: { portId: MOCK_PORT_ID },
            tick: state.tick,
          },
        };
        advanced += 1;
        return { events, ticksAdvanced: advanced, halt: { kind: "hook" } };
      }
    }

    return { events, ticksAdvanced: advanced, halt: { kind: "completed" } };
  },

  enqueueCommand(world, command: Command): EnqueueResult {
    const { state } = world;
    const commandId = command.id;
    const applyAtTick = command.targetTick ?? state.tick + 1;

    switch (command.kind) {
      case "acknowledgeHook": {
        const hookId = command.payload.hookId;
        if (state.narrator.pendingHook?.id !== hookId) {
          return {
            status: "rejected",
            commandId,
            rejection: { code: "preconditionFailed", reason: "no matching pending hook" },
          };
        }
        const { pendingHook: _dropped, ...rest } = state.narrator;
        state.narrator = rest;
        return { status: "accepted", commandId, applyAtTick };
      }
      case "surfaceDecision": {
        const decisionId = `x${state.nextId.decision}` as DecisionId;
        state.nextId = { ...state.nextId, decision: state.nextId.decision + 1 };
        const card = command.payload.card;
        const perspectiveActorId = (Object.keys(state.actors)[0] ?? "a1") as ActorId;
        state.decisions = {
          records: {
            ...state.decisions.records,
            [decisionId]: {
              id: decisionId,
              origin: "narrator",
              perspectiveActorId,
              prompt: card.prompt,
              left: { label: card.left.label, commands: [...card.left.commands] },
              right: { label: card.right.label, commands: [...card.right.commands] },
              status: "pending",
              createdTick: state.tick,
            },
          },
          queue: [...state.decisions.queue, decisionId],
        };
        return { status: "accepted", commandId, applyAtTick };
      }
      case "resolveDecision": {
        const { decisionId, side } = command.payload;
        const decision = state.decisions.records[decisionId];
        if (!decision || decision.status !== "pending") {
          return {
            status: "rejected",
            commandId,
            rejection: { code: "preconditionFailed", reason: "decision not pending" },
          };
        }
        state.decisions = {
          records: {
            ...state.decisions.records,
            [decisionId]: {
              ...decision,
              status: "resolved",
              resolvedTick: state.tick,
              chosen: side,
            },
          },
          queue: state.decisions.queue.filter((id) => id !== decisionId),
        };
        return { status: "accepted", commandId, applyAtTick };
      }
      default:
        return {
          status: "rejected",
          commandId,
          rejection: {
            code: "invalidPayload",
            reason: `mock kernel does not implement ${command.kind}`,
          },
        };
    }
  },

  getAgentView(world, actorId): AgentView {
    const actor = world.state.actors[actorId];
    if (!actor) {
      throw new Error(`mock kernel: unknown actor ${actorId}`);
    }
    const loc = actor.location.kind === "onDeck" ? actor.location : undefined;
    return {
      tick: world.state.tick,
      self: {
        id: actor.id,
        name: actor.name,
        roleTags: actor.roleTags,
        needs: actor.needs,
        capacities: actor.capacities,
        skills: actor.skills,
        traits: actor.traits,
        mood: actor.mood,
        location: actor.location,
        ...(loc ? { tile: { x: Math.floor(loc.x), y: Math.floor(loc.y) } } : {}),
        activity: actor.activity,
        inventory: [],
        onDuty: true,
        lastPlannedTick: actor.lastPlannedTick,
      },
      schematic: {
        deck: undefined as never,
        isFloor: () => true,
        compartmentAt: () => undefined,
        isWall: () => false,
        doors: () => [],
        machines: () => [],
        amenities: () => [],
      },
      fact: () => undefined,
      facts: () => [],
      knownProblems: () => [],
      knownTasks: () => [],
      roster: () =>
        Object.values(world.state.actors).map((a) => ({
          actorId: a.id,
          name: a.name,
          roleTags: a.roleTags,
          skills: a.skills,
        })),
    };
  },

  getRenderFrame(world): RenderFrame {
    const { state } = world;
    const bk = bookkeepingFor(state);
    const tickerEvents = bk.pendingTicker.slice(-6);
    bk.pendingTicker = [];

    return {
      tick: state.tick,
      actors: Object.values(state.actors)
        .filter((a): a is Actor & { location: { kind: "onDeck" } } => a.location.kind === "onDeck")
        .map((a) => ({
          id: a.id,
          name: a.name,
          deckId: (a.location as { deckId: typeof MOCK_DECK_ID }).deckId,
          x: (a.location as { x: number }).x,
          y: (a.location as { y: number }).y,
          facing: a.facing,
          actionLabel: bk.actors[a.id]?.actionLabel ?? "idle",
        })),
      machines: Object.values(state.machines).map((m) => ({
        id: m.id,
        state: machineStateAt(state.tick, bk.machineStageStartTick[m.id] ?? 0),
        temperatureNorm: m.temperature,
      })),
      doors: Object.values(state.doors).map((d) => ({ id: d.id, physicalState: d.physicalState })),
      travel: { state: state.travel.stage, progress: 0 },
      tickerEvents,
      money: state.money.balance,
    };
  },

  serialize(world): SaveEnvelope {
    return {
      schemaVersion: world.state.schemaVersion,
      simVersion: SIM_VERSION,
      contentHash: world.content.hash,
      configHash: world.config.hash,
      savedAtTick: world.state.tick,
      config: world.config.values,
      // The mock only ever needs to round-trip through structured clone (postMessage /
      // IndexedDB), not real JSON; a deep clone is enough and keeps the bookkeeping WeakMap keyed
      // correctly relative to whichever object is "the" state at save time.
      state: structuredClone(world.state),
    };
  },

  restore(envelope): World {
    const state = structuredClone(envelope.state);
    bookkeepingByState.set(state, bookkeepingFor(state));
    return {
      state,
      caches: {
        dirty: { navigation: false, power: false, inventory: false },
        nav: { geometryRevision: 0, edgeMask: {} },
        index: {} as World["caches"]["index"],
        diagnostics: {} as World["caches"]["diagnostics"],
      },
      content: MOCK_CONTENT_BUNDLE,
      config: { values: envelope.config, hash: envelope.configHash },
    };
  },
};
