/**
 * Integration 2 headless run: the real authored bundle, every V1 system in the worker's order
 * (`createFullRegistry`), an auto-accept decision policy and a stand-in narrator, for five
 * sim-minutes. Checks the freight loop and the crew's day actually happen, not just that nothing
 * throws.
 *
 * D40: the narrator is the only source of work, and `apps/web` may not import `@crew/narrator`,
 * so `answerHook` plays the narrator here: it answers each `captainAshore` hook with one offer built
 * from the port's first job template, the way the null narrator does offline.
 */
import type {
  ActorId,
  Command,
  CommandId,
  MachineId,
  NarratorHook,
  PortDefId,
  SimEvent,
  World,
} from "@crew/sim";
import { actionLabel, checkInvariants, isOnDock } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { assertInvariants, newGame } from "./testGame";

const TICK_RATE = 20;
const FIVE_MINUTES = TICK_RATE * 300;
const INJECT_FAULT_AT = TICK_RATE * 30;

type Policy = (world: World) => "left" | "right";
const autoAccept: Policy = () => "left";

/**
 * The stand-in narrator's answer to a hook: for `captainAshore`, one surfaced offer of the port's
 * first freight template (an item with a cargo class and a route) at its maximum count (the
 * kernel clamps to `maxCratesPerJob`) and the band's lowest pay; nothing for other hooks.
 */
function answerHook(world: World, hook: NarratorHook): Omit<Command, "id"> | undefined {
  if (hook.kind !== "captainAshore") return undefined;
  const portId = hook.context.portId as PortDefId;
  const port = world.content.ports[portId];
  if (port === undefined) return undefined;
  for (const template of port.jobTemplates) {
    const line = template.cargo[0];
    const distance = port.routes.find((r) => r.toPortId === template.toPortId)?.distance;
    const cargoClass =
      line === undefined ? undefined : world.content.items[line.itemDefId]?.cargoClass;
    if (line === undefined || distance === undefined || cargoClass === undefined) continue;
    const band = world.config.values.commerce.priceBands[cargoClass];
    return {
      source: "narrator",
      kind: "offerJob",
      payload: {
        job: {
          issuer: { name: "Stand-in Narrator", role: "dispatcher" },
          description: { key: "test.job", params: {} },
          fromPortId: portId,
          toPortId: template.toPortId,
          cargo: [{ itemDefId: line.itemDefId, count: line.countMax }],
          pay: Math.ceil(band.min * distance * line.countMax),
        },
        surface: true,
      },
    };
  }
  return undefined;
}

interface HaulClaim {
  readonly tick: number;
  readonly actorId: ActorId;
  readonly jobId: string;
}

interface RunLog {
  readonly events: SimEvent[];
  readonly labels: Map<ActorId, Set<string>>;
  decisions: number;
  readonly hooks: string[];
  readonly stages: Set<string>;
  /**
   * `taskClaimed` resolved against the claimed task's `cargoToLoad` job, captured the same tick
   * it fires: tasks are garbage-collected once their problem no longer needs them (`derivation.ts`),
   * so looking this up after the run is over finds nothing (item 4's haul-claim check needs it).
   */
  readonly loadClaims: HaulClaim[];
  /**
   * Ticks of `preparingDeparture` with someone on the dock: D61's call aboard (the last hauler
   * walking back from the delivery bay), which holds prep but is not the pilot's walk.
   */
  readonly prepAshoreTicks: Set<number>;
}

function runFullSim(seed: number, ticks: number, policy: Policy): { world: World; log: RunLog } {
  const { kernel, world } = newGame(seed);
  const log: RunLog = {
    events: [],
    labels: new Map(),
    decisions: 0,
    hooks: [],
    stages: new Set([world.state.travel.stage]),
    loadClaims: [],
    prepAshoreTicks: new Set(),
  };
  let n = 0;
  const send = (command: Omit<Command, "id">) => {
    n += 1;
    const result = kernel.enqueueCommand(world, {
      ...command,
      id: `cmd:test:${n}` as CommandId,
    } as Command);
    if (result.status !== "accepted") {
      throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
    }
  };

  let faultInjected = false;
  while (world.state.tick < ticks) {
    if (!faultInjected && world.state.tick >= INJECT_FAULT_AT) {
      faultInjected = true;
      const pump = Object.values(world.state.machines).find(
        (m) => m.defId === "machine.coolant_pump",
      );
      if (pump === undefined) throw new Error("no machine with faults in the bundle");
      const faultKey = world.content.machines[pump.defId]?.faults[0]?.key;
      if (faultKey === undefined) throw new Error("unreachable");
      send({
        source: "scenario",
        kind: "scenarioInjectFault",
        payload: { machineId: pump.id as MachineId, faultKey },
      });
    }
    const result = kernel.advance(world, 1);
    log.events.push(...result.events);
    log.stages.add(world.state.travel.stage);
    if (
      world.state.travel.stage === "preparingDeparture" &&
      Object.values(world.state.actors).some((a) =>
        isOnDock(world.content, world.state, a.location),
      )
    ) {
      log.prepAshoreTicks.add(world.state.tick);
    }
    for (const e of result.events) {
      if (e.type !== "taskClaimed") continue;
      const task = world.state.work.tasks[e.payload.taskId];
      if (task?.type !== "haul") continue;
      const problem = world.state.work.problems[task.problemId];
      if (problem?.kind !== "cargoToLoad") continue;
      log.loadClaims.push({
        tick: e.tick,
        actorId: e.subjectIds[0] as ActorId,
        jobId: problem.payload.jobId,
      });
    }
    assertInvariants(world);
    for (const actor of Object.values(world.state.actors)) {
      if (!actor.crew) continue;
      const set = log.labels.get(actor.id) ?? new Set<string>();
      set.add(actionLabel(actor, world.state, world.content));
      log.labels.set(actor.id, set);
    }
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      log.hooks.push(hook.kind);
      const answer = answerHook(world, hook);
      if (answer !== undefined) send(answer);
      send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      log.decisions += 1;
      send({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: policy(world) },
      });
    }
  }
  return { world, log };
}

const count = (log: RunLog, type: SimEvent["type"]) =>
  log.events.filter((e) => e.type === type).length;

/**
 * D63: port work is physical, so a port call with freight both ways takes longer than when the
 * crates jumped aboard at the ramp; the crew's-day case runs until the ship has left its second
 * port (the pilot only gets up from the helm once it is under way again). D65: with the hand
 * truck the second call is shorter and the ship is at a third port by seven minutes, the pilot
 * back at the helm before anything else came up; by eight it has left that one too. D73: on
 * Freighter Mk2 with nine crew this seed draws an engine controller fault on the first leg, so the
 * ship drifts for about two minutes and reaches the third port at about 7.6 minutes; both dock
 * dressings (Green Meridian, Kessler Drift) still fall inside the eight.
 */
const EIGHT_MINUTES = TICK_RATE * 480;

// Each case simulates five to eight minutes of the whole ship on real content; several sit near
// vitest's default 5 s, so the suite gets headroom rather than flaking on a slow runner.
describe(
  "full sim: real content, every system, auto-accept (Integration 2)",
  { timeout: 20_000 },
  () => {
    it("runs the freight loop and the crew's day for eight sim-minutes", () => {
      const { world, log } = runFullSim(20260930, EIGHT_MINUTES, autoAccept);
      if (process.env.FULLSIM_DEBUG) {
        for (const e of log.events) {
          if (e.significance === "trace") continue;
          console.log(
            e.tick,
            e.type,
            JSON.stringify(e.payload).slice(0, 140),
            e.subjectIds.join(","),
          );
        }
        console.log("hooks", log.hooks, "decisions", log.decisions, "stages", [...log.stages]);
        for (const [id, l] of log.labels) console.log(id, [...l].join(" | "));
        console.log(
          JSON.stringify(world.state.travel),
          JSON.stringify(Object.values(world.state.jobs)),
        );
        console.log(
          Object.values(world.state.work.problems)
            .map((p) => `${p.kind}:${p.status}:${p.visibility}:${JSON.stringify(p.payload)}`)
            .join("\n"),
        );
        console.log(
          Object.values(world.state.work.tasks)
            .map(
              (t) =>
                `${t.type}:${JSON.stringify(t.claimState)}:${JSON.stringify(t.blockage ?? null)}`,
            )
            .join("\n"),
        );
        for (const m of Object.values(world.state.machines))
          console.log(
            m.id,
            m.defId,
            m.actualMode,
            m.output.toFixed(2),
            m.temperature.toFixed(2),
            JSON.stringify(m.faults),
          );
      }

      // Freight: a job is taken, its cargo is hauled aboard by the crew, the ship leaves port.
      expect(count(log, "jobAccepted")).toBeGreaterThanOrEqual(1);
      const loadProblems = Object.values(world.state.work.problems).filter(
        (p) => p.kind === "cargoToLoad",
      );
      expect(loadProblems.some((p) => p.status === "resolved")).toBe(true);
      expect([...log.stages].some((stage) => stage !== "docked")).toBe(true);
      // One offer card per port call (three in eight minutes, D65) and at most the departure gate.
      expect(log.decisions).toBeLessThanOrEqual(4);

      // Ship systems: the fault injected at 30 s is found and fixed.
      expect(count(log, "faultOccurred")).toBeGreaterThanOrEqual(1);
      expect(count(log, "faultDiagnosed")).toBeGreaterThanOrEqual(1);
      expect(count(log, "faultRepaired")).toBeGreaterThanOrEqual(1);

      // The crew's day: everyone does at least three different things.
      expect(log.labels.size).toBe(9);
      for (const [actorId, labels] of log.labels) {
        expect(labels.size, `${actorId}: ${[...labels].join(" | ")}`).toBeGreaterThanOrEqual(3);
      }
      expect(checkInvariants(world.state)).toEqual([]);

      // D66: every dock came alongside with somebody on it, and no dock hand had to give up a
      // walk (only the dock leaving may cut one short).
      const dressed = log.events.filter(
        (e): e is Extract<SimEvent, { type: "dockDressed" }> => e.type === "dockDressed",
      );
      expect(dressed.length).toBeGreaterThanOrEqual(2);
      for (const e of dressed) {
        expect(e.payload.localIds.length).toBeGreaterThan(0);
        expect(e.payload.unplaced).toEqual([]);
      }
      const gaveUp = log.events.filter(
        (e) => e.type === "dockHandGaveUp" && e.payload.reason !== "castOff",
      );
      expect(gaveUp).toEqual([]);
      expect(log.hooks.filter((h) => h === "stageDock").length).toBeGreaterThanOrEqual(2);
    }, 30_000);

    it("does not stall preparingDeparture waiting for the pilot to walk to the console", () => {
      // Owner feedback 2026-09-30: `stationToStaff` used to open only once `preparingDeparture`
      // began, so the pilot did not start walking to the console until every crate was aboard —
      // adding the whole walk (observed 10-17 sim-s) on top of the fixed prep time. `travel.ts`
      // now raises `stationToStaff` as soon as a course is planned, so the pilot (idle, with
      // nothing else essential to do) walks there while the crew is still loading; by the time
      // `preparingDeparture` starts the console should already be staffed.
      const { world, log } = runFullSim(20260930, FIVE_MINUTES, autoAccept);
      const stageChanges = log.events.filter(
        (e): e is Extract<SimEvent, { type: "travelStageChanged" }> =>
          e.type === "travelStageChanged",
      );
      const prepStarts = stageChanges.filter((e) => e.payload.to === "preparingDeparture");
      expect(prepStarts.length).toBeGreaterThanOrEqual(1);
      const prepSeconds = world.config.values.travel.prepareDepartureSeconds;
      const tickRate = world.config.values.time.tickRate;
      for (const start of prepStarts) {
        const next = stageChanges.find(
          (e) => e.tick > start.tick && e.payload.from === "preparingDeparture",
        );
        expect(next).toBeDefined();
        const end = next?.tick ?? start.tick;
        let ashore = 0;
        for (const tick of log.prepAshoreTicks) if (tick > start.tick && tick <= end) ashore += 1;
        const elapsedSeconds = (end - start.tick - ashore) / tickRate;
        // The fixed prep time plus a small (≤ 2 s) allowance, not the extra walk the bug added.
        // D61's call aboard (someone still on the dock as prep begins) is not counted here.
        expect(elapsedSeconds).toBeLessThanOrEqual(prepSeconds + 2);
      }
    });

    it("never lets one actor claim a multi-crate job's whole stack at once", () => {
      // Owner feedback 2026-09-30 item 4: once freight spawns as individual crates (`acceptJob`),
      // a job with several units gives several crew independent haul tasks to claim, not one
      // actor working through the whole stack alone. D65: with the hand truck one actor moves up
      // to its capacity per trip, and what is beyond one trip's worth stays open for anyone free
      // (on this seed nobody else is free while the first trip runs, so the pusher comes back).
      const { world, log } = runFullSim(20260930, FIVE_MINUTES, autoAccept);
      const bigJob = Object.values(world.state.jobs).find((j) => j.cargoItemIds.length >= 6);
      expect(bigJob).toBeDefined();
      if (bigJob === undefined) return;
      const capacity =
        Object.values(world.content.items).find((i) => i.toolKinds.includes("handTruck"))
          ?.capacityUnits ?? 0;
      expect(capacity).toBe(4);
      const claims = log.loadClaims.filter((c) => c.jobId === bigJob.id);
      expect(claims).toHaveLength(bigJob.cargoItemIds.length);
      // Claims one actor makes in one tick are one trip: more than one crate, never more than the
      // truck carries, so never the lot.
      const trips = new Map<string, number>();
      for (const c of claims) {
        const key = `${c.tick}:${c.actorId}`;
        trips.set(key, (trips.get(key) ?? 0) + 1);
      }
      const biggest = Math.max(...trips.values());
      expect(biggest).toBeGreaterThan(1);
      expect(biggest).toBeLessThanOrEqual(capacity);
      expect(trips.size).toBeGreaterThanOrEqual(2);
    });
  },
);
