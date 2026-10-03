/**
 * Integration 2 headless run: the real authored bundle, every V1 system in the worker's order
 * (`createFullRegistry`), an auto-accept decision policy and a stand-in narrator, for five
 * sim-minutes. Checks the freight loop and the crew's day actually happen, not just that nothing
 * throws.
 *
 * D40: the narrator is the only source of work, and `apps/web` may not import `@crew/narrator`,
 * so `answerHook` plays the narrator here: it answers each `jobBoard` hook with one offer built
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
import {
  actionLabel,
  checkInvariants,
  createKernel,
  spatialViolations,
  travelViolations,
  workViolations,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";

const TICK_RATE = 20;
const FIVE_MINUTES = TICK_RATE * 300;
const INJECT_FAULT_AT = TICK_RATE * 30;

type Policy = (world: World) => "left" | "right";
const autoAccept: Policy = () => "left";

/**
 * The stand-in narrator's answer to a hook: for `jobBoard`, one surfaced offer of the port's
 * first freight template (an item with a cargo class and a route) at its maximum count (the
 * kernel clamps to `maxCratesPerJob`) and the band's lowest pay; nothing for other hooks.
 */
function answerHook(world: World, hook: NarratorHook): Omit<Command, "id"> | undefined {
  if (hook.kind !== "jobBoard") return undefined;
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
}

function runFullSim(seed: number, ticks: number, policy: Policy): { world: World; log: RunLog } {
  const { bundle, config, scenarioId } = loadWebContent();
  const kernel = createKernel(createFullRegistry());
  const world = kernel.createWorld(scenarioId, seed, bundle, config);
  const log: RunLog = {
    events: [],
    labels: new Map(),
    decisions: 0,
    hooks: [],
    stages: new Set([world.state.travel.stage]),
    loadClaims: [],
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
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...workViolations(world),
      ...travelViolations(world),
    ];
    if (violations.length > 0) {
      throw new Error(`tick ${world.state.tick}: ${violations.slice(0, 5).join("; ")}`);
    }
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

// Each case simulates five minutes of the whole ship on real content; several sit near vitest's
// default 5 s, so the suite gets headroom rather than flaking on a slow runner.
describe(
  "full sim: real content, every system, auto-accept (Integration 2)",
  { timeout: 20_000 },
  () => {
    it("runs the freight loop and the crew's day for five sim-minutes", () => {
      const { world, log } = runFullSim(20260930, FIVE_MINUTES, autoAccept);
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
      expect(log.decisions).toBeLessThanOrEqual(3);

      // Ship systems: the fault injected at 30 s is found and fixed.
      expect(count(log, "faultOccurred")).toBeGreaterThanOrEqual(1);
      expect(count(log, "faultDiagnosed")).toBeGreaterThanOrEqual(1);
      expect(count(log, "faultRepaired")).toBeGreaterThanOrEqual(1);

      // The crew's day: everyone does at least three different things.
      expect(log.labels.size).toBe(8);
      for (const [actorId, labels] of log.labels) {
        expect(labels.size, `${actorId}: ${[...labels].join(" | ")}`).toBeGreaterThanOrEqual(3);
      }
      expect(checkInvariants(world.state)).toEqual([]);
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
        const elapsedSeconds = ((next?.tick ?? start.tick) - start.tick) / tickRate;
        // The fixed prep time plus a small (≤ 2 s) allowance, not the extra walk the bug added.
        expect(elapsedSeconds).toBeLessThanOrEqual(prepSeconds + 2);
      }
    });

    it("hauls a multi-crate job with more than one actor", () => {
      // Owner feedback 2026-09-30 item 4: once freight spawns as individual crates (`acceptJob`),
      // a job with several units should give several idle cargo-skilled crew independent haul
      // tasks to claim, not one actor working through the whole stack alone.
      const { world, log } = runFullSim(20260930, FIVE_MINUTES, autoAccept);
      const bigJob = Object.values(world.state.jobs).find((j) => j.cargoItemIds.length >= 3);
      expect(bigJob).toBeDefined();
      if (bigJob === undefined) return;
      const haulers = new Set(
        log.loadClaims.filter((c) => c.jobId === bigJob.id).map((c) => c.actorId),
      );
      expect(haulers.size).toBeGreaterThanOrEqual(2);
    });
  },
);
