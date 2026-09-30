/**
 * Programmatic narrator fixtures built from the real content through the headless kernel, for
 * tests and for `crew narrator eval`. The world is created by the kernel, then nudged into the
 * situation under test by writing state directly (a fixture, not a simulation).
 */
import {
  type ActorId,
  type ContentBundle,
  type EventId,
  type MachineId,
  type PortDefId,
  type ScenarioDefId,
  type SimEvent,
  type World,
  allocateId,
  createKernel,
  createRegistry,
} from "@crew/sim";
import type { NarratorRequest } from "./contract";

export const FIXTURE_SCENARIO = "scenario.default_freighter_run" as ScenarioDefId;
const HUB = "port.crossroads_hub" as PortDefId;
const DRIFT = "port.kessler_drift" as PortDefId;
const MERIDIAN = "port.green_meridian" as PortDefId;

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
