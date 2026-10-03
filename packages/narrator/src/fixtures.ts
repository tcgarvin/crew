/**
 * Programmatic narrator fixtures built from the real content through the headless kernel, for
 * tests and for `crew narrator eval`. The world is created by the kernel, then nudged into the
 * situation under test by writing state directly (a fixture, not a simulation).
 */
import {
  type Actor,
  type ActorId,
  type ContentBundle,
  type CrewDefId,
  type DecisionId,
  type EventId,
  type JobId,
  type MachineId,
  PASSENGER_OVERDUE_PROMPT_KEY,
  type PortDefId,
  type SaveEnvelope,
  type ScenarioDefId,
  type SimEvent,
  type World,
  type WorldState,
  allocateId,
  configTicks,
  createKernel,
  createRegistry,
} from "@crew/sim";
import type { NarratorRequest } from "./contract";

export const FIXTURE_SCENARIO = "scenario.default_freighter_run" as ScenarioDefId;
const HUB = "port.crossroads_hub" as PortDefId;
const DRIFT = "port.kessler_drift" as PortDefId;
const MERIDIAN = "port.green_meridian" as PortDefId;
const OSSORY = "port.ossory_station" as PortDefId;

function newWorld(content: ContentBundle, seed: number) {
  const kernel = createKernel(createRegistry());
  const world = kernel.createWorld(FIXTURE_SCENARIO, seed, content, {
    values: content.config,
    hash: content.hash,
  });
  return { kernel, world };
}

function machineByDef(world: World, defId: string): MachineId {
  const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`fixture: no machine of def ${defId}`);
  return machine.id;
}

function crewIds(world: World): ActorId[] {
  return Object.values(world.state.actors)
    .filter((a) => a.crew)
    .map((a) => a.id)
    .sort();
}

function event<T extends SimEvent["type"]>(
  n: number,
  tick: number,
  type: T,
  payload: Extract<SimEvent, { type: T }>["payload"],
  significance: SimEvent["significance"],
  subjectIds: readonly string[] = [],
): SimEvent {
  return {
    id: `evt${n}` as EventId,
    tick,
    seq: 0,
    type,
    subjectIds,
    causeIds: [],
    source: "sim",
    significance,
    payload,
  } as unknown as SimEvent;
}

/** Nudge needs so the digest has something to show. */
function tireCrew(world: World): void {
  const ids = crewIds(world);
  ids.forEach((id, i) => {
    const actor = world.state.actors[id];
    if (actor === undefined) return;
    actor.needs = {
      hunger: (i * 0.13) % 0.9,
      fatigue: (i * 0.21) % 0.95,
      comfort: 0.1,
      social: (i * 0.17) % 0.8,
    };
  });
}

/** Approaching Kessler Drift from Crossroads Hub, no jobs yet. */
export function approachingPortRequest(content: ContentBundle, seed = 11): NarratorRequest {
  const { kernel, world } = newWorld(content, seed);
  const state = world.state;
  const tick = 1_800;
  state.tick = tick;
  state.travel = {
    stage: "approaching",
    fromPortId: HUB,
    toPortId: DRIFT,
    stageProgress: 0.2,
    routeProgress: 25,
    routeDistance: 25,
    drifting: false,
    stageStartedTick: tick - 40,
  };
  tireCrew(world);
  const hook = {
    id: allocateId(state, "hook"),
    kind: "approachingPort" as const,
    context: { portId: DRIFT, etaTicks: 200 },
    tick,
  };
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = 900;
  const recentEvents = [
    event(1, 900, "departed", { fromPortId: HUB, toPortId: DRIFT }, "narrative"),
    event(2, 1_740, "travelStageChanged", { from: "transit", to: "approaching" }, "trace"),
  ];
  return { gameId: "fixture-approaching", hook, snapshot: kernel.serialize(world), recentEvents };
}

/**
 * In transit to Green Meridian with a paying job aboard; the coolant pump has a worn bearing
 * that nobody has noticed yet.
 */
export function quietTooLongRequest(content: ContentBundle, seed = 23): NarratorRequest {
  const { kernel, world } = newWorld(content, seed);
  const state = world.state;
  const tick = 4_000;
  state.tick = tick;
  state.travel = {
    stage: "transit",
    fromPortId: HUB,
    toPortId: MERIDIAN,
    stageProgress: 0,
    routeProgress: 20,
    routeDistance: 45,
    drifting: false,
    stageStartedTick: 3_300,
  };
  tireCrew(world);
  const pumpId = machineByDef(world, "machine.coolant_pump");
  const pump = state.machines[pumpId];
  if (pump === undefined) throw new Error("fixture: pump vanished");
  pump.faults.push({
    faultKey: "worn_bearing",
    sinceTick: 3_700,
    diagnosed: false,
    repairStepIndex: 0,
    repairStepProgress: 0,
  });
  pump.output = 0.6;
  pump.condition = 0.55;
  const jobId = allocateId(state, "job");
  state.jobs[jobId] = {
    id: jobId,
    origin: "portBoard",
    issuer: "Tobiah Rask, Meridian Trading House",
    issuerPerson: { name: "Tobiah Rask", role: "freight broker", org: "Meridian Trading House" },
    pitch: {
      key: "job.pitch",
      params: {},
      prose: "Four crates for the growers. They've been waiting since before the lane reopened.",
    },
    urgency: "soon",
    description: { key: "job.template", params: { template: "crates_to_agri" } },
    fromPortId: HUB,
    toPortId: MERIDIAN,
    cargo: [{ itemDefId: "item.crate_general" as never, count: 4 }],
    cargoClass: "general",
    pay: 540,
    status: "inTransit",
    offeredTick: 2_600,
    expiresAtTick: 14_600,
    cargoItemIds: [],
  };
  const hook = {
    id: allocateId(state, "hook"),
    kind: "quietTooLong" as const,
    context: { quietSinceTick: 3_200 },
    tick,
  };
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = 3_200;
  const recentEvents = [
    event(1, 2_900, "jobAccepted", { jobId }, "narrative", [jobId]),
    event(2, 3_200, "departed", { fromPortId: HUB, toPortId: MERIDIAN }, "narrative"),
    // Truth only: nobody knows. `trace` significance, so the digest skips it.
    event(3, 3_700, "faultOccurred", { machineId: pumpId, faultKey: "worn_bearing" }, "trace", [
      pumpId,
    ]),
  ];
  return { gameId: "fixture-quiet", hook, snapshot: kernel.serialize(world), recentEvents };
}

/** Docked at Kessler Drift with nothing on offer, so the captain is looking for work (D40). */
export function jobBoardRequest(content: ContentBundle, seed = 11): NarratorRequest {
  const base = approachingPortRequest(content, seed);
  const tick = 2_400;
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  snapshot.state.tick = tick;
  snapshot.state.travel = { stage: "docked", portId: DRIFT };
  const hook = {
    id: allocateId(snapshot.state, "hook"),
    kind: "jobBoard" as const,
    context: { portId: DRIFT },
    tick,
  };
  snapshot.state.narrator.pendingHook = hook;
  return { gameId: "fixture-board", hook, snapshot, recentEvents: [] };
}

/**
 * Passengers-and-galaxy §9 (live suite): docked at Crossroads Hub with nothing on offer, where
 * Ossory Station is two hops away (Hub, Kessler Drift, Ossory) and Tern's Rest one long leg, so
 * a `jobBoard` answer can reach for a far port. The approach fixture's crew and money, but the
 * ship never left the Hub.
 */
export function farJobBoardRequest(content: ContentBundle, seed = 11): NarratorRequest {
  const base = approachingPortRequest(content, seed);
  const tick = 2_400;
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  snapshot.state.tick = tick;
  snapshot.state.travel = { stage: "docked", portId: HUB };
  const hook = {
    id: allocateId(snapshot.state, "hook"),
    kind: "jobBoard" as const,
    context: { portId: HUB },
    tick,
  };
  snapshot.state.narrator.pendingHook = hook;
  snapshot.state.narrator.lastNarrativeTick = 0;
  return { gameId: "fixture-far-board", hook, snapshot, recentEvents: [] };
}

/** The far fixture's far port, for tests that assert on it. */
export const FAR_FIXTURE_PORT = OSSORY;

/** The passenger of the passage fixtures, for tests that assert on her. */
export const FIXTURE_PASSENGER = "Halla Thorne";

/**
 * A passenger aboard, as the kernel would spawn her on accept (passengers §3.5): the
 * `crew.passenger` body at the deck's passenger spawn point, with the issuer's name and no
 * skills. Built from a copy of a crew member's record, since the kernel's `newActor` is internal.
 */
function boardPassenger(state: WorldState, content: ContentBundle, name: string): Actor {
  const template = Object.values(state.actors).find(
    (a) => a.crew && !a.roleTags.includes("captain") && a.location.kind === "onDeck",
  );
  const aboard = template?.location;
  if (template === undefined || aboard === undefined || aboard.kind !== "onDeck") {
    throw new Error("fixture: no crew member aboard to model the passenger on");
  }
  const deck = Object.values(content.decks).find((d) => d.id === aboard.deckId);
  const spawn = deck?.spawnPoints.find((p) => p.tags.includes("passenger"))?.tile;
  if (deck === undefined || spawn === undefined) {
    throw new Error("fixture: the deck has no passenger spawn point");
  }
  const id = allocateId(state, "actor");
  const passenger: Actor = {
    ...structuredClone(template),
    id,
    defId: "crew.passenger" as CrewDefId,
    name,
    roleTags: [],
    skills: {},
    traits: [],
    location: { kind: "onDeck", deckId: deck.id, x: spawn.x + 0.5, y: spawn.y + 0.5 },
    movement: { kind: "stationary" },
    activity: { kind: "idle" },
    knowledge: {},
    passenger: true,
  };
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete passenger.pendingIntent;
  state.actors[id] = passenger;
  return passenger;
}

/** A round-trip passage Hub -> Ossory -> Hub for `actorId`, accepted at the Hub. */
function roundTripPassage(state: WorldState, actorId: ActorId, acceptedTick: number): JobId {
  const jobId = allocateId(state, "job");
  state.jobs[jobId] = {
    id: jobId,
    origin: "narrator",
    issuer: "Halla Thorne, assayer",
    issuerPerson: { name: FIXTURE_PASSENGER, role: "assayer" },
    pitch: {
      key: "narrator.job.pitch",
      params: {},
      prose: "I need to get to Ossory and back, and I'd rather not say why on an open dock.",
    },
    urgency: "soon",
    description: {
      key: "narrator.job.description",
      params: {},
      prose: "Passage to Ossory Station and home again. She says she has a claim to sell.",
    },
    fromPortId: HUB,
    toPortId: OSSORY,
    cargo: [],
    cargoClass: "general",
    pay: 2_600,
    status: "inTransit",
    offeredTick: acceptedTick - 60,
    expiresAtTick: acceptedTick + 12_000,
    cargoItemIds: [],
    passage: { actorId, roundTrip: true, leg: "out" },
  };
  return jobId;
}

/**
 * Passengers-and-galaxy §3.2: in transit on the first leg of a round trip, Hub -> Kessler Drift
 * on the way to Ossory Station, with Halla Thorne aboard and nothing story-worthy for a while.
 */
export function passengerAboardRequest(content: ContentBundle, seed = 29): NarratorRequest {
  const { kernel, world } = newWorld(content, seed);
  const state = world.state;
  const tick = 3_600;
  state.tick = tick;
  state.travel = {
    stage: "transit",
    fromPortId: HUB,
    toPortId: DRIFT,
    stageProgress: 0,
    routeProgress: 12,
    routeDistance: 25,
    drifting: false,
    stageStartedTick: 3_300,
    voyageDestinationId: OSSORY,
  };
  tireCrew(world);
  const passenger = boardPassenger(state, content, FIXTURE_PASSENGER);
  const jobId = roundTripPassage(state, passenger.id, 2_900);
  const hook = {
    id: allocateId(state, "hook"),
    kind: "quietTooLong" as const,
    context: { quietSinceTick: 3_200 },
    tick,
  };
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = 3_200;
  const who = { jobId, actorId: passenger.id, name: passenger.name };
  const recentEvents = [
    event(1, 2_900, "jobAccepted", { jobId }, "narrative", [jobId]),
    event(2, 2_905, "passengerBoarded", who, "notable", [passenger.id, jobId]),
    event(3, 3_200, "departed", { fromPortId: HUB, toPortId: DRIFT }, "narrative"),
  ];
  return { gameId: "fixture-passenger", hook, snapshot: kernel.serialize(world), recentEvents };
}

/**
 * Passengers-and-galaxy §3.3: docked at Ossory Station on the round trip, Halla Thorne ashore
 * past the overdue window, the sim's overdue card pending with the first officer as its speaker
 * (modelled on the departure-gate fixture), under a `policyDecision` hook.
 */
export function passengerOverdueRequest(content: ContentBundle, seed = 29): NarratorRequest {
  const { kernel, world } = newWorld(content, seed);
  const state = world.state;
  const config = world.config.values;
  const ashoreTick = 7_000;
  const overdueTicks = configTicks(config, config.commerce.passage.overdueSeconds);
  const tick = ashoreTick + overdueTicks + 30;
  state.tick = tick;
  state.travel = {
    stage: "docked",
    portId: OSSORY,
    plannedDestinationId: DRIFT,
    voyageDestinationId: HUB,
  };
  tireCrew(world);
  const passenger = boardPassenger(state, content, FIXTURE_PASSENGER);
  passenger.availability = "offShip";
  passenger.location = { kind: "inExternalStore", portId: OSSORY, storeKey: "lounge" };
  const jobId = roundTripPassage(state, passenger.id, 2_900);
  const job = state.jobs[jobId];
  if (job === undefined) throw new Error("fixture: job vanished");
  job.passage = {
    actorId: passenger.id,
    roundTrip: true,
    leg: "ashore",
    ashoreSinceTick: ashoreTick,
    returnsAtTick: tick + 300,
  };
  const captain = Object.values(state.actors).find((a) => a.roleTags.includes("captain"));
  const firstOfficer = Object.values(state.actors).find(
    (a) => a.passenger !== true && a.roleTags.includes("firstOfficer"),
  );
  if (captain === undefined || firstOfficer === undefined) throw new Error("fixture lacks crew");
  const decisionId = allocateId(state, "decision");
  state.decisions.records[decisionId] = {
    id: decisionId,
    origin: "policy",
    perspectiveActorId: captain.id,
    prompt: {
      key: PASSENGER_OVERDUE_PROMPT_KEY,
      params: {
        jobId,
        actorId: passenger.id,
        name: passenger.name,
        port: OSSORY,
        speaker: firstOfficer.name,
      },
    },
    left: {
      label: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.wait`, params: {} },
      commands: [],
      aftermath: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.wait.aftermath`, params: {} },
    },
    right: {
      label: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.leave`, params: {} },
      commands: [{ kind: "endPassage", payload: { jobId } }],
      aftermath: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.leave.aftermath`, params: {} },
    },
    status: "pending",
    createdTick: tick,
  };
  state.decisions.queue.push(decisionId);
  const hook = {
    id: allocateId(state, "hook"),
    kind: "policyDecision" as const,
    context: { decisionId },
    tick,
  };
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = ashoreTick;
  const who = { jobId, actorId: passenger.id, name: passenger.name };
  const recentEvents = [
    event(1, ashoreTick - 40, "arrived", { portId: OSSORY }, "narrative"),
    event(2, ashoreTick, "passengerAshore", { ...who, portId: OSSORY }, "notable", [
      passenger.id,
      jobId,
    ]),
    event(3, tick, "decisionPending", { decisionId }, "narrative"),
  ];
  return { gameId: "fixture-overdue", hook, snapshot: kernel.serialize(world), recentEvents };
}

/**
 * The ship has started drifting in transit to Green Meridian (the coolant pump's worn bearing
 * finally bit): a `driftingChanged` event, which `config.narrator.hookOnEvents` lists, raised
 * the `notableEvent` hook the following tick.
 */
export function notableEventRequest(content: ContentBundle, seed = 23): NarratorRequest {
  const base = quietTooLongRequest(content, seed);
  const tick = 4_101;
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  const state = snapshot.state;
  state.tick = tick;
  if (state.travel.stage === "docked") throw new Error("fixture: expected the ship in transit");
  state.travel = { ...state.travel, drifting: true };
  const drifted = event(4, 4_100, "driftingChanged", { drifting: true }, "narrative");
  const hook = {
    id: allocateId(state, "hook"),
    kind: "notableEvent" as const,
    context: { eventIds: [drifted.id] },
    tick,
  };
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = 4_100;
  state.narrator.lastNarrativeEvent = { tick: 4_100, type: "driftingChanged", eventId: drifted.id };
  return {
    gameId: "fixture-notable",
    hook,
    snapshot,
    recentEvents: [...base.recentEvents, drifted],
  };
}

/**
 * D37: a departure-gate card (D36) as the kernel queues it, with the fixture's engineer named as
 * the speaker in the template params, under a `policyDecision` hook naming the engine.
 */
export function departureGateRequest(content: ContentBundle, seed = 11): NarratorRequest {
  const base = approachingPortRequest(content, seed);
  const snapshot = structuredClone(base.snapshot) as SaveEnvelope;
  const decisionId = "d9" as DecisionId;
  const actors = Object.values(snapshot.state.actors);
  const captain = actors[0];
  const engineer = actors.find((a) => a.roleTags.includes("engineer"));
  if (captain === undefined || engineer === undefined) throw new Error("fixture lacks crew");
  const engine = Object.values(snapshot.state.machines).find((m) =>
    content.machines[m.defId]?.tags.includes("engine"),
  );
  if (engine === undefined) throw new Error("fixture lacks an engine");
  snapshot.state.decisions.records[decisionId] = {
    id: decisionId,
    origin: "policy",
    perspectiveActorId: captain.id,
    prompt: {
      key: "travel.departureGate",
      params: {
        machineId: engine.id,
        machine: content.machines[engine.defId]?.name ?? "Main Engine",
        reason: "fault",
        speaker: engineer.name,
      },
    },
    left: {
      label: { key: "travel.departureGate.hold", params: {} },
      commands: [],
      aftermath: { key: "travel.departureGate.hold.aftermath", params: {} },
    },
    right: {
      label: { key: "travel.departureGate.leave", params: {} },
      commands: [],
      aftermath: { key: "travel.departureGate.leave.aftermath", params: {} },
    },
    status: "pending",
    createdTick: base.hook.tick,
    narratorHookId: base.hook.id,
  };
  snapshot.state.decisions.queue.push(decisionId);
  const hook = {
    id: base.hook.id,
    kind: "policyDecision" as const,
    context: { decisionId, machineId: engine.id },
    tick: base.hook.tick,
  };
  snapshot.state.narrator.pendingHook = hook;
  // The kernel announces the decision in the tick that raises the hook (D37).
  const recentEvents = [
    ...base.recentEvents,
    event(3, base.hook.tick, "decisionPending", { decisionId }, "narrative"),
  ];
  return { ...base, hook, snapshot, recentEvents };
}
