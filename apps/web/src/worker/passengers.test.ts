/**
 * Passengers-and-galaxy §9 kernel integration: the real authored bundle and every V1 system
 * (`createFullRegistry`), a round-trip passage from Crossroads Hub to Ossory Station through
 * Kessler Drift, with a return drawn later than the overdue card. One run answers "Wait for
 * them" and asserts the fare and the event trail; the other answers "Leave without them" and
 * asserts the passenger stays at Ossory as an off-ship actor with no fare paid.
 *
 * It lives here, not in `packages/sim`, for the same reason `fullSim.test.ts` does: the kernel
 * package may not depend on `@crew/content`.
 */
import type {
  ActorId,
  Command,
  CommandId,
  NarratorHook,
  PortDefId,
  SimEvent,
  World,
} from "@crew/sim";
import { checkInvariants, createKernel, spatialViolations, workViolations } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";

const HUB = "port.crossroads_hub" as PortDefId;
const KESSLER = "port.kessler_drift" as PortDefId;
const OSSORY = "port.ossory_station" as PortDefId;
const OVERDUE_KEY = "commerce.passengerOverdue";

/** Hub -> Kessler -> Ossory is 145; the round trip is banded over 290. */
const ROUND_TRIP_DISTANCE = 290;

const MAX_TICKS = 20 * 900;

interface RunLog {
  readonly events: SimEvent[];
  readonly hooks: string[];
  /** Where `jobBoard` was asked, in order: the home port only, never a waypoint or the far port. */
  readonly jobBoardPorts: PortDefId[];
  readonly headlines: Set<string>;
  readonly arrivals: PortDefId[];
}

function passageOffer(world: World): Omit<Command, "id"> {
  const band = world.config.values.commerce.priceBands.passenger;
  return {
    source: "narrator",
    kind: "offerJob",
    payload: {
      job: {
        issuer: { name: "Halla Thorne", role: "assayer" },
        pitch: {
          key: "narrator.job.pitch",
          params: {},
          prose: "I need to get to Ossory and back.",
        },
        description: { key: "narrator.job.description", params: {}, prose: "A claim to sell." },
        fromPortId: HUB,
        toPortId: OSSORY,
        cargo: [],
        pay: Math.ceil(band.min * ROUND_TRIP_DISTANCE),
        passenger: true,
        roundTrip: true,
      },
      surface: true,
    },
  };
}

function runPassage(overdueChoice: "left" | "right"): { world: World; log: RunLog } {
  const { bundle, config, scenarioId } = loadWebContent();
  // Faster legs and a stay ashore that outlasts the overdue window; everything else authored.
  const values = {
    ...config.values,
    travel: { ...config.values.travel, nominalSpeed: 10 },
    commerce: {
      ...config.values.commerce,
      passage: { ashoreSecondsMin: 120, ashoreSecondsMax: 120, overdueSeconds: 45 },
    },
  };
  const kernel = createKernel(createFullRegistry());
  const world = kernel.createWorld(scenarioId, 20261002, bundle, {
    values,
    hash: `${config.hash}-passengers`,
  });
  const log: RunLog = {
    events: [],
    hooks: [],
    jobBoardPorts: [],
    headlines: new Set(),
    arrivals: [],
  };
  let n = 0;
  const send = (command: Omit<Command, "id">) => {
    n += 1;
    const result = kernel.enqueueCommand(world, {
      ...command,
      id: `cmd:passengers:${n}` as CommandId,
    } as Command);
    if (result.status !== "accepted") {
      throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
    }
  };
  let offered = false;
  const answerHook = (hook: NarratorHook): Omit<Command, "id"> | undefined => {
    if (hook.kind !== "jobBoard" || offered || hook.context.portId !== HUB) return undefined;
    offered = true;
    return passageOffer(world);
  };
  const choose = (promptKey: string): "left" | "right" => {
    if (promptKey === OVERDUE_KEY) return overdueChoice;
    // Leave anyway at the gate, so a random engine fault cannot stall the run.
    if (promptKey === "travel.departureGate") return "right";
    return "left";
  };

  const done = () => {
    const job = Object.values(world.state.jobs)[0];
    return (
      job !== undefined &&
      (job.status === "paid" || job.status === "failed") &&
      world.state.travel.stage === "docked" &&
      world.state.travel.portId === HUB
    );
  };
  while (world.state.tick < MAX_TICKS && !done()) {
    const result = kernel.advance(world, 1);
    log.events.push(...result.events);
    for (const e of result.events) if (e.type === "arrived") log.arrivals.push(e.payload.portId);
    log.headlines.add(kernel.getRenderFrame(world).headline.split(" — ")[0] ?? "");
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...workViolations(world),
    ];
    if (violations.length > 0) {
      throw new Error(`tick ${world.state.tick}: ${violations.slice(0, 5).join("; ")}`);
    }
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      log.hooks.push(hook.kind);
      if (hook.kind === "jobBoard") log.jobBoardPorts.push(hook.context.portId);
      const answer = answerHook(hook);
      if (answer !== undefined) send(answer);
      send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      const decision = world.state.decisions.records[head];
      if (decision === undefined) throw new Error("decision vanished");
      send({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: choose(decision.prompt.key) },
      });
    }
  }
  return { world, log };
}

const ofType = <T extends SimEvent["type"]>(log: RunLog, type: T) =>
  log.events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** Real content and every system: a few seconds alone, longer under the parallel suite. */
const REAL_CONTENT_TIMEOUT_MS = 20_000;

describe("round-trip passage Hub -> Ossory through Kessler (real content, every system)", () => {
  it(
    "waits for the late passenger, brings them home and pays the fare once",
    () => {
      const { world, log } = runPassage("left");
      const job = Object.values(world.state.jobs)[0];
      if (job === undefined) throw new Error("no job");
      const fare = job.pay;
      const start = world.content.scenarios[world.state.scenarioId]?.startingMoney ?? 0;

      expect(job.status).toBe("paid");
      expect(job.passage).toMatchObject({ roundTrip: true, leg: "back", endReason: "completed" });
      expect(log.arrivals).toEqual([KESSLER, OSSORY, KESSLER, HUB]);

      const boarded = ofType(log, "passengerBoarded");
      expect(boarded).toHaveLength(1);
      const actorId = boarded[0]?.payload.actorId as ActorId;
      expect(boarded[0]?.payload.name).toBe("Halla Thorne");
      expect(ofType(log, "passengerAshore").map((e) => e.payload.portId)).toEqual([OSSORY]);
      const overdue = Object.values(world.state.decisions.records).filter(
        (d) => d.prompt.key === OVERDUE_KEY,
      );
      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toMatchObject({ origin: "policy", status: "resolved", chosen: "left" });
      expect(overdue[0]?.prompt.params).toMatchObject({
        name: "Halla Thorne",
        speaker: "Dane Whitcross",
      });
      expect(ofType(log, "passengerReturned")).toHaveLength(1);
      expect(log.hooks).toContain("policyDecision");
      expect(log.hooks).toContain("notableEvent");
      expect(ofType(log, "passageEnded").map((e) => e.payload)).toEqual([
        { jobId: job.id, actorId, name: "Halla Thorne", reason: "completed", portId: HUB },
      ]);
      expect(ofType(log, "contractCompleted")).toHaveLength(1);
      expect(ofType(log, "paymentMade").map((e) => e.payload.amount)).toEqual([fare]);
      expect(world.state.money.balance).toBe(
        start - 4 * world.config.values.commerce.dockingFee + fare,
      );
      expect(world.state.actors[actorId]).toBeUndefined();
      expect([...log.headlines].some((h) => h.startsWith("Waiting for Halla Thorne"))).toBe(true);
      // The passage is the job in hand: the board asks at the home port only, never at Kessler
      // on the way or at Ossory on arrival.
      expect(log.jobBoardPorts[0]).toBe(HUB);
      expect(log.jobBoardPorts.filter((p) => p !== HUB)).toEqual([]);
      expect(checkInvariants(world.state)).toEqual([]);
    },
    REAL_CONTENT_TIMEOUT_MS,
  );

  it(
    "leaves the late passenger at Ossory when told to, with no fare",
    () => {
      const { world, log } = runPassage("right");
      const job = Object.values(world.state.jobs)[0];
      if (job === undefined) throw new Error("no job");
      const start = world.content.scenarios[world.state.scenarioId]?.startingMoney ?? 0;

      expect(job.status).toBe("failed");
      expect(job.passage).toMatchObject({ leg: "ashore", endReason: "leftBehind" });
      expect(log.arrivals).toEqual([KESSLER, OSSORY, KESSLER, HUB]);
      const actorId = ofType(log, "passengerBoarded")[0]?.payload.actorId as ActorId;
      expect(ofType(log, "passengerReturned")).toHaveLength(0);
      expect(ofType(log, "passageEnded").map((e) => e.payload)).toEqual([
        { jobId: job.id, actorId, name: "Halla Thorne", reason: "leftBehind", portId: OSSORY },
      ]);
      expect(ofType(log, "paymentMade")).toHaveLength(0);
      expect(world.state.money.balance).toBe(start - 4 * world.config.values.commerce.dockingFee);
      const halla = world.state.actors[actorId];
      expect(halla).toMatchObject({
        name: "Halla Thorne",
        passenger: true,
        availability: "offShip",
        location: { kind: "inExternalStore", portId: OSSORY, storeKey: "lounge" },
      });
      expect(log.jobBoardPorts.filter((p) => p !== HUB)).toEqual([]);
      expect(checkInvariants(world.state)).toEqual([]);
    },
    REAL_CONTENT_TIMEOUT_MS,
  );
});
