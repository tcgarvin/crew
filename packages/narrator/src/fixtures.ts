/**
 * Programmatic narrator fixtures built from the real content through the headless kernel, for
 * tests and for `crew narrator eval`. The world is created by the kernel, then nudged into the
 * situation under test by writing state directly (a fixture, not a simulation).
 */
import {
  type Actor,
  type ActorId,
  type Command,
  type CommandId,
  type ContentBundle,
  type CrewDefId,
  DEFAULT_PLANS,
  type DecisionId,
  type EventId,
  type HullScar,
  type ItemDefId,
  type JobId,
  type KernelRegistry,
  type MachineId,
  PASSENGER_OVERDUE_PROMPT_KEY,
  type PortDefId,
  type SaveEnvelope,
  type ScenarioDefId,
  type SimEvent,
  type World,
  type WorldState,
  allocateId,
  clearDockside,
  createKernel,
  createRegistry,
  dayTicks,
  defaultPairFor,
  dockAlongside,
  dockForPort,
  dressDock,
  expectedDock,
  floorSet,
  personnelRampFoot,
  planMenu,
  registerExpedition,
  registerSpatial,
  siteOf,
} from "@crew/sim";
import type { NarratorRequest } from "./contract";

export const FIXTURE_SCENARIO = "scenario.default_freighter_run" as ScenarioDefId;
const HUB = "port.crossroads_hub" as PortDefId;
const DRIFT = "port.kessler_drift" as PortDefId;
const MERIDIAN = "port.green_meridian" as PortDefId;
const OSSORY = "port.ossory_station" as PortDefId;

/**
 * §travel-stages: the dock alongside follows the travel stage. A fixture that writes the stage by
 * hand calls this after, so the snapshot never has the start port's dock alongside in flight.
 */
function alignDock(state: WorldState, content: ContentBundle): void {
  const due = expectedDock(content, state.travel);
  const deckId = Object.keys(state.deck.tiles)[0] as keyof WorldState["deck"]["tiles"] | undefined;
  if (due === undefined || deckId === undefined) {
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete state.deck.dock;
    clearDockside(state);
    return;
  }
  state.deck.dock = { dockId: due.id, deckId };
  // §floor-set-rule: the dock alongside comes with its floor set, as the sim dresses it.
  dressDock(state, content, undefined, state.tick, 1);
}

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
      recreation: 0.3,
    };
  });
}

/**
 * Approaching Kessler Drift from Crossroads Hub, no jobs yet, on a `quietTooLong` check-in.
 * `approachingPort` is retired (§staging-hook-and-the-hold: arrival is the staging call's), which
 * this fixture used to carry; the ship on approach is still the base the other fixtures build on.
 */
export function approachRequest(content: ContentBundle, seed = 11): NarratorRequest {
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
  alignDock(state, content);
  tireCrew(world);
  const hook = {
    id: allocateId(state, "hook"),
    kind: "quietTooLong" as const,
    context: { quietSinceTick: 900 },
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
 * §staging-hook-and-the-hold: the staging call for Kessler Drift, as the sim raises it: in transit
 * from Crossroads Hub, `narrator.approachHookLeadSeconds` from the end of the route, the travel
 * record `raised` for this hook, and the hook's context carrying the floor set (Kessler's posted
 * regulars).
 */
export function stageDockRequest(content: ContentBundle, seed = 11): NarratorRequest {
  const { kernel, world } = newWorld(content, seed);
  const state = world.state;
  const tick = 1_600;
  state.tick = tick;
  const lead = content.config.narrator.approachHookLeadSeconds * content.config.travel.nominalSpeed;
  const dock = dockForPort(content, DRIFT);
  if (dock === undefined) throw new Error("fixture content has no Kessler Drift dock");
  const hook = {
    id: allocateId(state, "hook"),
    kind: "stageDock" as const,
    context: { portId: DRIFT, dockId: dock.id, floorSet: floorSet(state, content, DRIFT) },
    tick,
  };
  state.travel = {
    stage: "transit",
    fromPortId: HUB,
    toPortId: DRIFT,
    stageProgress: (25 - lead) / 25,
    routeProgress: 25 - lead,
    routeDistance: 25,
    drifting: false,
    stageStartedTick: tick - 200,
    staging: { status: "raised", hookId: hook.id },
  };
  alignDock(state, content);
  tireCrew(world);
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = tick;
  const recentEvents = [
    event(1, 900, "departed", { fromPortId: HUB, toPortId: DRIFT }, "narrative"),
  ];
  return { gameId: "fixture-stage-dock", hook, snapshot: kernel.serialize(world), recentEvents };
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
  alignDock(state, content);
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

/**
 * §looking-for-work: the captain has walked down the personnel ramp and stands at its foot on the
 * dock alongside, looking for work: the moment `captainAshore` is raised. Returns the captain's id.
 */
function captainSteppedAshore(state: WorldState, content: ContentBundle): ActorId {
  const captain = Object.values(state.actors).find((a) => a.roleTags.includes("captain"));
  const presence = state.deck.dock;
  const berth = dockAlongside(content, state);
  if (captain === undefined || presence === undefined || berth === undefined) {
    throw new Error("captainAshore fixture: no captain or no dock alongside");
  }
  const foot = personnelRampFoot(content, presence.deckId, berth);
  if (foot === undefined) throw new Error("captainAshore fixture: the dock has no ramp foot");
  captain.location = { kind: "onDeck", deckId: presence.deckId, x: foot.x + 0.5, y: foot.y + 0.5 };
  return captain.id;
}

/**
 * The approach fixture's crew and money docked at `portId` with nothing on offer, the captain
 * just stepped onto the dock to look for work (D40, §looking-for-work).
 */
function captainAshoreAt(
  content: ContentBundle,
  seed: number,
  portId: PortDefId,
  gameId: string,
): NarratorRequest {
  const base = approachRequest(content, seed);
  const tick = 2_400;
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  snapshot.state.tick = tick;
  snapshot.state.travel = { stage: "docked", portId };
  alignDock(snapshot.state, content);
  const actorId = captainSteppedAshore(snapshot.state, content);
  const hook = {
    id: allocateId(snapshot.state, "hook"),
    kind: "captainAshore" as const,
    context: { portId, actorId },
    tick,
  };
  snapshot.state.narrator.pendingHook = hook;
  return { gameId, hook, snapshot, recentEvents: [] };
}

/** Docked at Kessler Drift; the captain has just stepped onto the dock to look for work. */
export function captainAshoreRequest(content: ContentBundle, seed = 11): NarratorRequest {
  return captainAshoreAt(content, seed, DRIFT, "fixture-board");
}

/**
 * Passengers-and-galaxy §9 (live suite): docked at Crossroads Hub, where Ossory Station is two
 * hops away (Hub, Kessler Drift, Ossory) and Tern's Rest one long leg, so a `captainAshore`
 * answer can reach for a far port. The ship never left the Hub.
 */
export function farCaptainAshoreRequest(content: ContentBundle, seed = 11): NarratorRequest {
  const req = captainAshoreAt(content, seed, HUB, "fixture-far-board");
  req.snapshot.state.narrator.lastNarrativeTick = 0;
  return req;
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
  alignDock(state, content);
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
  const overdueTicks = dayTicks(config, config.commerce.passage.overdueDays);
  const tick = ashoreTick + overdueTicks + 30;
  state.tick = tick;
  state.travel = {
    stage: "docked",
    portId: OSSORY,
    plannedDestinationId: DRIFT,
    voyageDestinationId: HUB,
  };
  alignDock(state, content);
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
  alignDock(state, content);
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
 * §policy-decision-hook: a departure-gate card (§departure-gate) as the kernel queues it, with the
 * fixture's engineer named as the speaker in the template params, under a `policyDecision` hook
 * naming the engine.
 */
export function departureGateRequest(content: ContentBundle, seed = 11): NarratorRequest {
  const base = approachRequest(content, seed);
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
  // The kernel announces the decision in the tick that raises the hook (§policy-decision-hook).
  const recentEvents = [
    ...base.recentEvents,
    event(3, base.hook.tick, "decisionPending", { decisionId }, "narrative"),
  ];
  return { ...base, hook, snapshot, recentEvents };
}

/**
 * §requested-call-back: the departure call the narrator asked for when it offered the Meridian run
 * at Crossroads Hub. The ship has just cast off (`departing`, the tick `departed` is emitted) with
 * the whole 45 s leg ahead; the request is in state, served by this `requestedCall` hook.
 */
export function requestedCallRequest(content: ContentBundle, seed = 23): NarratorRequest {
  const base = quietTooLongRequest(content, seed);
  const tick = 3_300;
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  const state = snapshot.state;
  state.tick = tick;
  state.travel = {
    stage: "departing",
    fromPortId: HUB,
    toPortId: MERIDIAN,
    stageProgress: 0,
    routeProgress: 0,
    routeDistance: 45,
    drifting: false,
    stageStartedTick: tick,
  };
  alignDock(state, content);
  // A clean ship: the pump's wear is the quiet check-in's business, not this leg's.
  for (const machine of Object.values(state.machines)) {
    machine.faults = [];
    machine.output = 1;
    machine.condition = 1;
  }
  const why = "spring a debris field on the junior pilot";
  const requestedTick = 2_900;
  const hook = {
    id: allocateId(state, "hook"),
    kind: "requestedCall" as const,
    context: { when: "departure" as const, why, requestedTick },
    tick,
  };
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = tick;
  state.narrator.callBack = { when: "departure", why, requestedTick, portId: HUB };
  state.narrator.callBack.servedByHookId = hook.id;
  const recentEvents = [
    ...base.recentEvents.filter((e) => e.type === "jobAccepted"),
    event(2, tick, "departed", { fromPortId: HUB, toPortId: MERIDIAN }, "narrative"),
  ];
  return { gameId: "fixture-requested-call", hook, snapshot, recentEvents };
}

/**
 * §notable-event-hook: the aftermath of a field on the Meridian leg. The field is over and the
 * alert has stood down (`alertCleared`), the crew have reported in, and the hull carries one
 * unpatched scar.
 */
export function alertClearedRequest(content: ContentBundle, seed = 23): NarratorRequest {
  const base = quietTooLongRequest(content, seed);
  const tick = 4_400;
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  const state = snapshot.state;
  state.tick = tick;
  if (state.travel.stage === "docked") throw new Error("fixture: expected the ship in transit");
  state.travel = { ...state.travel, routeProgress: 38 };
  alignDock(state, content);
  const stores = Object.values(state.compartments).find((c) => c.key === "stores");
  if (stores === undefined) throw new Error("fixture: no stores room");
  const fieldId = "f1" as HullScar["fieldId"];
  state.hull.scars.push({
    id: "r1" as HullScar["id"],
    fieldId,
    tile: { x: 1, y: 1 },
    compartmentId: stores.id,
    rock: "large",
    damage: 8,
    recovered: 0,
    patched: false,
    tick: 4_250,
  });
  state.hull.integrity = state.hull.max - 8;
  const cleared = event(
    5,
    4_390,
    "fieldCleared",
    {
      fieldId,
      how: "crossed",
      impacts: 4,
      hullLost: 8,
      integrity: state.hull.integrity,
      max: state.hull.max,
    },
    "narrative",
  );
  const stoodDown = event(6, 4_399, "alertCleared", { cause: "field" }, "notable");
  const hook = {
    id: allocateId(state, "hook"),
    kind: "notableEvent" as const,
    context: { eventIds: [stoodDown.id] },
    tick,
  };
  state.narrator.pendingHook = hook;
  state.narrator.lastNarrativeTick = 4_390;
  state.narrator.lastNarrativeEvent = { tick: 4_399, type: "alertCleared", eventId: stoodDown.id };
  return {
    gameId: "fixture-alert-cleared",
    hook,
    snapshot,
    recentEvents: [...base.recentEvents, cleared, stoodDown],
  };
}

/** Expeditions A2: the site of the site fixture, and the person its errand is for. */
export const FIXTURE_SITE = "port.harrow_end" as PortDefId;
export const FIXTURE_ERRAND_TARGET = "Teodor Lusk";

/** "hold the ramp from cover (3 go)" → "Hold the ramp from cover": a plan's why as a side label. */
function planLabel(why: string): string {
  const words = why.split(" (")[0] ?? why;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Kernel = ReturnType<typeof createKernel>;

/** A site fixture's kernel and world, created from the fixture scenario. */
function siteWorld(content: ContentBundle, registry: KernelRegistry, seed: number) {
  const kernel = createKernel(registry);
  const world = kernel.createWorld(FIXTURE_SCENARIO, seed, content, {
    values: content.config,
    hash: content.hash,
  });
  return { kernel, world };
}

/** Set the docked ship down at the fixture site in place, with no plan yet. */
function setDownAtSite(kernel: Kernel, world: World): void {
  const started = kernel.enqueueCommand(world, {
    id: "cmd:fixture:site" as CommandId,
    source: "scenario",
    targetTick: world.state.tick + 1,
    kind: "scenarioStartExpedition",
    payload: { siteId: FIXTURE_SITE },
  } as Command);
  if (started.status === "rejected") {
    throw new Error(`site fixture: the expedition did not start: ${started.rejection.reason}`);
  }
  kernel.advance(world, 1);
}

/** The captain and the first officer: every site card is the captain's, brought by the officer. */
function captainAndFirstOfficer(state: WorldState): { captain: Actor; firstOfficer: Actor } {
  const captain = Object.values(state.actors).find((a) => a.roleTags.includes("captain"));
  const firstOfficer = Object.values(state.actors).find(
    (a) => a.crew && a.passenger !== true && a.roleTags.includes("firstOfficer"),
  );
  if (captain === undefined || firstOfficer === undefined) throw new Error("fixture lacks crew");
  return { captain, firstOfficer };
}

/** The errand the site fixtures are on: Ysolde Maren's, from the Hub, for the steward alive. */
function writeFixtureErrand(state: WorldState, jobId: JobId): void {
  const tick = state.tick;
  state.jobs[jobId] = {
    id: jobId,
    origin: "narrator",
    issuer: "Ysolde Maren",
    issuerPerson: { name: "Ysolde Maren", role: "grower", org: "Meridian Growers Collective" },
    pitch: { key: "job.pitch", params: {}, prose: "Bring Teodor home. He owes the Collective." },
    urgency: "soon",
    description: { key: "job.template", params: {}, prose: "The steward ran with the seed money." },
    fromPortId: HUB,
    toPortId: HUB,
    cargo: [],
    cargoClass: "general",
    pay: 0,
    status: "inTransit",
    offeredTick: 0,
    expiresAtTick: tick + 10_000,
    cargoItemIds: [],
    errand: {
      kind: "fetchPerson",
      siteId: FIXTURE_SITE,
      targetName: FIXTURE_ERRAND_TARGET,
      wants: "alive",
      returnToPortId: HUB,
    },
  };
}

/**
 * D105: the item errand of the item-arrival fixture: Ysolde Maren's, from the Hub, for the
 * Collective's seed stock (a perishable crate) at Harrow End, wanted either way.
 */
export const FIXTURE_ERRAND_ITEM = "item.crate_perishable" as ItemDefId;
export const FIXTURE_ERRAND_ITEM_NAME = "the Collective's seed stock";

function writeItemErrand(state: WorldState, jobId: JobId): void {
  writeFixtureErrand(state, jobId);
  const job = state.jobs[jobId];
  if (job === undefined) throw new Error("site fixture: no errand");
  state.jobs[jobId] = {
    ...job,
    pitch: {
      key: "job.pitch",
      params: {},
      prose: "Teodor sold our seed out from under us. Bring it home before it lifts off-world.",
    },
    description: {
      key: "job.template",
      params: {},
      prose: "The Collective's seed stock, crated at the old silo yard for an off-world buyer.",
    },
    errand: {
      kind: "fetchItem",
      siteId: FIXTURE_SITE,
      targetName: FIXTURE_ERRAND_ITEM_NAME,
      itemDefId: FIXTURE_ERRAND_ITEM,
      wants: "either",
      returnToPortId: HUB,
    },
  };
}

/**
 * The item errand's thing at the site's loot post, as the landing start lays it there
 * (`scenarioStartExpedition` does not).
 */
function placeLoot(state: WorldState, content: ContentBundle, itemDefId: ItemDefId): void {
  const berth = siteOf(content, state);
  const post = berth?.dock.posts.find((p) => p.kind === "loot");
  const def = content.items[itemDefId];
  const { captain } = captainAndFirstOfficer(state);
  if (berth === undefined || post === undefined || def === undefined) {
    throw new Error("site fixture: no loot post or item");
  }
  if (captain.location.kind !== "onDeck") throw new Error("site fixture: captain not on deck");
  const location = {
    kind: "onDeck",
    deckId: captain.location.deckId,
    x: post.tile.x - berth.shipAt.x + 0.5,
    y: post.tile.y - berth.shipAt.y + 0.5,
  } as const;
  const id = allocateId(state, "item");
  state.items[id] =
    def.stacking === "unique"
      ? { id, defId: def.id, stacking: "unique", location, condition: 1 }
      : { id, defId: def.id, stacking: "stack", location, count: 1, reserved: 0 };
}

/**
 * The arrival card, pending, as `queueArrivalCard` raises it: brought by the first officer, its
 * sides the errand kind's default pair (`defaultPairFor`, each an `adoptPlan`), each side's label
 * and why in the side's own params as well as the prompt's, with the errand's kind.
 */
function writeArrivalCard(world: World, content: ContentBundle, jobId: JobId): DecisionId {
  const state = world.state;
  const errand = state.jobs[jobId]?.errand;
  if (errand === undefined) throw new Error("site fixture: no errand");
  const { captain, firstOfficer } = captainAndFirstOfficer(state);
  const menu = planMenu(state, content, world.config.values);
  const [left, right] = defaultPairFor(errand.kind).map((d) => menu.find((o) => o.id === d.id));
  if (left === undefined || right === undefined) throw new Error("site fixture: no default pair");
  const leftLabel = planLabel(left.why);
  const rightLabel = planLabel(right.why);
  const decisionId = allocateId(state, "decision");
  const key = "expedition.arrival";
  state.decisions.records[decisionId] = {
    id: decisionId,
    origin: "policy",
    perspectiveActorId: captain.id,
    prompt: {
      key,
      params: {
        jobId,
        kind: errand.kind,
        site: FIXTURE_SITE,
        target: errand.targetName,
        speaker: firstOfficer.name,
        leftPlan: left.id,
        rightPlan: right.id,
        leftLabel,
        rightLabel,
        leftWhy: left.why,
        rightWhy: right.why,
      },
    },
    left: {
      label: { key: `${key}.left`, params: { leftLabel } },
      commands: [{ kind: "adoptPlan", payload: { planId: left.id } }],
      aftermath: { key: `${key}.left.aftermath`, params: { leftWhy: left.why } },
    },
    right: {
      label: { key: `${key}.right`, params: { rightLabel } },
      commands: [{ kind: "adoptPlan", payload: { planId: right.id } }],
      aftermath: { key: `${key}.right.aftermath`, params: { rightWhy: right.why } },
    },
    status: "pending",
    createdTick: state.tick,
  };
  state.decisions.queue.push(decisionId);
  return decisionId;
}

/** Raise `policyDecision` for `decisionId` as the hook the host is answering. */
function policyHook(state: WorldState, decisionId: DecisionId) {
  const hook = {
    id: allocateId(state, "hook"),
    kind: "policyDecision" as const,
    context: { decisionId },
    tick: state.tick,
  };
  state.narrator.pendingHook = hook;
  return hook;
}

/**
 * Expeditions A2 (plan calls 4, 12): set down at Harrow End for an errand offered at the Hub, the
 * expedition started on landing (the cast at their posts, no plan yet) and the arrival card up
 * under its `policyDecision` hook (`writeArrivalCard`). The sim's `scenarioStartExpedition` puts
 * the site alongside and spawns the cast; the errand, `jobId` and the card are written by hand.
 */
export function siteArrivalRequest(content: ContentBundle, seed = 31): NarratorRequest {
  const registry = createRegistry();
  registerSpatial(registry);
  registerExpedition(registry);
  const { kernel, world } = siteWorld(content, registry, seed);
  setDownAtSite(kernel, world);
  const state = world.state;
  const expedition = state.expedition;
  if (expedition === undefined) throw new Error("site fixture: no expedition");
  const jobId = allocateId(state, "job");
  writeFixtureErrand(state, jobId);
  expedition.jobId = jobId;
  const decisionId = writeArrivalCard(world, content, jobId);
  expedition.cards = { arrival: decisionId };
  const hook = policyHook(state, decisionId);
  const recentEvents = [event(1, state.tick, "decisionPending", { decisionId }, "narrative")];
  return { gameId: "fixture-site-arrival", hook, snapshot: kernel.serialize(world), recentEvents };
}

/**
 * D105: the arrival fixture for an item errand: the Collective's seed stock at Harrow End's loot
 * post (the seed container doors), the cast as the site has them (`castFor` leaves an item
 * errand's cast alone, so Teodor Lusk is there under his own name), and the item errand's pair on
 * the card: creep in quietly holding fire (left) or go in hard (right). The narrator may mark a
 * side the way in unseen on this call.
 */
export function siteItemArrivalRequest(content: ContentBundle, seed = 31): NarratorRequest {
  const registry = createRegistry();
  registerSpatial(registry);
  registerExpedition(registry);
  const { kernel, world } = siteWorld(content, registry, seed);
  setDownAtSite(kernel, world);
  const state = world.state;
  const expedition = state.expedition;
  if (expedition === undefined) throw new Error("site fixture: no expedition");
  const jobId = allocateId(state, "job");
  writeItemErrand(state, jobId);
  placeLoot(state, content, FIXTURE_ERRAND_ITEM);
  expedition.jobId = jobId;
  const decisionId = writeArrivalCard(world, content, jobId);
  expedition.cards = { arrival: decisionId };
  const hook = policyHook(state, decisionId);
  const recentEvents = [event(1, state.tick, "decisionPending", { decisionId }, "narrative")];
  return {
    gameId: "fixture-site-item-arrival",
    hook,
    snapshot: kernel.serialize(world),
    recentEvents,
  };
}

/**
 * Expeditions A2 (plan call 15): the arrival fixture moved on to the fight's turn, written by hand
 * as the turn card's own test does (`site-digest.test.ts`). The captain took the left side (hold
 * the ramp from cover); the party (the captain, the first officer and the two best hands after
 * them, all on their feet but one) is out and the fight is on; the last of them is down. The turn
 * card is up under its `policyDecision` hook as `queueTurnCard` raises it for our side's setback:
 * `side` `us`, `how` `down`, brought by the first officer, "Press on" (no commands) or "Pull back to
 * the ship" (`withdrawParty`).
 */
export function siteTurnRequest(content: ContentBundle, seed = 31): NarratorRequest {
  const base = siteArrivalRequest(content, seed);
  const tick = base.snapshot.state.tick + 600;
  const snapshot: SaveEnvelope = { ...structuredClone(base.snapshot), savedAtTick: tick };
  const state = snapshot.state;
  const expedition = state.expedition;
  const arrivalId = expedition?.cards?.arrival;
  const jobId = expedition?.jobId;
  if (expedition === undefined || arrivalId === undefined || jobId === undefined) {
    throw new Error("site fixture: no expedition");
  }
  state.tick = tick;
  const arrival = state.decisions.records[arrivalId];
  const plan = planMenu(state, content, snapshot.config).find((o) => o.id === DEFAULT_PLANS[0]?.id);
  if (arrival === undefined || plan === undefined) throw new Error("site fixture: no plan");
  arrival.status = "resolved";
  arrival.chosen = "left";
  arrival.resolvedTick = tick - 600;
  state.decisions.queue = state.decisions.queue.filter((id) => id !== arrivalId);
  const { captain, firstOfficer } = captainAndFirstOfficer(state);
  const hands = Object.values(state.actors)
    .filter(
      (a) => a.crew && a.passenger !== true && a.id !== captain.id && a.id !== firstOfficer.id,
    )
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
    .slice(0, 2);
  const party = [captain, firstOfficer, ...hands];
  const down = hands[hands.length - 1];
  if (down === undefined) throw new Error("site fixture: party too small");
  expedition.plan = plan.plan;
  expedition.party = party.map((a) => a.id);
  expedition.leaderId = captain.id;
  expedition.phase = "fight";
  expedition.fightStartedTick = tick - 200;
  for (const actor of party) {
    actor.combatant = {
      side: "us",
      disposition: { part: "ally", resolveBase: 0.7, loyalty: 1, wants: "nothing" },
      state: actor.id === down.id ? "down" : "steady",
      resolve: 0.7,
      lastDecidedTick: tick,
    };
  }
  down.availability = "incapacitated";
  const key = "expedition.turn";
  const turnId = allocateId(state, "decision");
  state.decisions.records[turnId] = {
    id: turnId,
    origin: "policy",
    perspectiveActorId: captain.id,
    prompt: {
      key,
      params: {
        jobId,
        site: FIXTURE_SITE,
        actorId: down.id,
        name: down.name,
        side: "us",
        how: "down",
        speaker: firstOfficer.name,
      },
    },
    left: {
      label: { key: `${key}.press`, params: {} },
      commands: [],
      aftermath: { key: `${key}.press.aftermath`, params: {} },
    },
    right: {
      label: { key: `${key}.withdraw`, params: {} },
      commands: [{ kind: "withdrawParty", payload: {} }],
      aftermath: { key: `${key}.withdraw.aftermath`, params: {} },
    },
    status: "pending",
    createdTick: tick,
  };
  state.decisions.queue.push(turnId);
  expedition.cards = { arrival: arrivalId, turn: turnId };
  const hook = policyHook(state, turnId);
  const recentEvents = [
    event(2, tick - 200, "expeditionContact", { siteId: FIXTURE_SITE }, "narrative"),
    event(3, tick, "decisionPending", { decisionId: turnId }, "narrative"),
  ];
  return { gameId: "fixture-site-turn", hook, snapshot, recentEvents };
}
