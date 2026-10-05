/**
 * `crew pacing`: the headless pacing run that gates phase 1 of passengers-and-galaxy (§7, §9).
 *
 * Runs a scripted there-and-back voyage (hub → Kessler → Ossory → Kessler → hub) on the real
 * content with every V1 system, a stub narrator and a simulated wall clock, and reports narrator
 * calls, sim time, wall time and narrator stall per playback speed (spec §2.2's table).
 *
 * ## The wall-clock model
 *
 * The web worker's host (`apps/web/src/worker/host.ts`) is replicated here rather than imported:
 * `apps/web` is not a dependency of the CLI and is compiled for the browser. The pieces that set
 * pacing are reproduced exactly; frames, snapshots and the view ring are not (they do not move
 * time).
 *
 * - The host loop runs every `LOOP_INTERVAL_MS` (50 ms) of wall time. Each iteration adds
 *   `elapsed × speed` to an accumulator and converts it to ticks wanted.
 * - Run-ahead (D14, D30): the sim may lead the viewer by up to `RUN_AHEAD_CAP_SECONDS` (60 s) of
 *   sim time. While budget remains the loop runs at least `BURST_TICKS_PER_LOOP` (40 ticks,
 *   2 sim-s) per iteration, so the lead builds at about 40 sim-s per wall-s regardless of speed
 *   and a fresh 60 s lead is in place about 1.5 s after any depletion.
 * - The viewer (the main thread's playback) consumes sim time at `speed × wall`, but can never
 *   pass the sim. Any wall time in which the viewer wanted to advance and could not is a
 *   **stall**: `stallSeconds` is the sum of those shortfalls, in wall seconds.
 * - A hook halts the sim (`advance` returns `halt.kind === "hook"`) until `acknowledgeHook` is
 *   queued. The stub narrator answers `latencySeconds` of wall time later with no commands.
 *   While the sim is halted the viewer keeps playing into the lead; the stall per call is
 *   therefore `max(0, latency − lead / speed)`, where `lead` is the sim-seconds in hand when the
 *   hook fired (60 s if the sim had been unhindered for ~1.5 s of wall time; less when hooks
 *   fall close together, e.g. `stageDock` then `captainAshore` at one docking). With a 60 s
 *   lead and 25 s latency: 0 s at 1x and 2x, 10 s at 4x, 17.5 s at 8x: spec §2.2.
 * - The viewer starts playing when the sim has produced its first tick. A hook at tick 0 (before
 *   any lead exists) would be paid in full at every speed as a load-time cost, reported as
 *   `startupSeconds`, not as stall. Since D70 none does: the first `captainAshore` comes when the
 *   captain steps onto the dock, some seconds in, so it is stall, partly hidden by the lead built
 *   while they walked. The script waits for each port's ask to be answered before it takes work or
 *   sets course, as a player answering the offer card would.
 * - Policy decisions halt the sim as hooks do; the stub resolves them by their left side at once
 *   (a real player's thinking time is not modelled, and none fire on this voyage anyway).
 * - Wall seconds for the run is the wall time at which the viewer has played the final tick, so
 *   `wall ≈ startupSeconds + simSeconds / speed + stallSeconds`.
 *
 * The sim itself is deterministic: the voyage takes the same number of ticks at every speed, so
 * only the stall column moves with speed, as in the spec's table.
 */
import { loadBundle } from "@crew/content";
import {
  type Command,
  type CommandId,
  type ContentBundle,
  type EffectiveConfig,
  type JobId,
  type Kernel,
  type KernelRegistry,
  type NarratorHook,
  type PortDefId,
  type ScenarioDefId,
  type World,
  commerceTaskDerivations,
  createKernel,
  createRegistry,
  daysToSeconds,
  dirtTaskDerivations,
  equipmentStages,
  equipmentTaskDerivation,
  galleyTaskDerivations,
  registerCommerce,
  registerDirt,
  registerEquipmentSystems,
  registerGalley,
  registerNeeds,
  registerPlannerDefaults,
  registerSpatial,
  registerTravel,
  registerWatch,
  registerWork,
  shortestPath,
  travelTaskDerivations,
} from "@crew/sim";

export const HUB_PORT_ID = "port.crossroads_hub" as PortDefId;
export const FAR_PORT_ID = "port.ossory_station" as PortDefId;

/** Host constants, matching `createHost`'s defaults. */
const LOOP_INTERVAL_MS = 50;
const RUN_AHEAD_CAP_SECONDS = 60;
const BURST_TICKS_PER_LOOP = 40;

/**
 * Narrator budget caps the report compares against: the pre-D51 default of
 * `CREW_NARRATOR_MAX_CALLS_PER_HOUR` (6) and the current one (30, `packages/server/src/env.ts`).
 * Plain numbers, not an import: the server reads the cap from the environment, not a constant.
 */
const HOURLY_CAPS = [6, 30] as const;

const DEFAULT_SPEEDS = [1, 2, 4, 8] as const;
const DEFAULT_LATENCY_SECONDS = 25;
const DEFAULT_SEED = 1;

/** How many ticks of sim time the run may take before it is declared stuck. */
const MAX_SIM_TICKS = 20 * 60 * 60;

const PACING_SCENARIOS = ["plain", "freight"] as const;
export type PacingScenario = (typeof PACING_SCENARIOS)[number];

export interface PacingOptions {
  readonly scenario: PacingScenario;
  readonly speed: number;
  readonly latencySeconds: number;
  readonly seed: number;
}

export interface HookCall {
  readonly kind: NarratorHook["kind"];
  readonly tick: number;
  readonly tickSeconds: number;
  /** Where the ship was when the hook fired: a port while docked, "from→to" under way. */
  readonly leg: string;
  /** Sim-seconds of run-ahead lead in hand when the hook fired. */
  readonly leadSeconds: number;
  /** Wall seconds the viewer stalled while waiting on this call. */
  readonly stallSeconds: number;
}

export interface LegReport {
  readonly fromPortId: PortDefId;
  readonly toPortId: PortDefId;
  /** Tick the ship left `docked` at `fromPortId`. */
  readonly departedTick: number;
  /** Tick the ship became `docked` at `toPortId`. */
  readonly dockedTick: number;
  readonly simSeconds: number;
  readonly hooksByKind: Readonly<Partial<Record<NarratorHook["kind"], number>>>;
}

export interface PacingResult {
  readonly scenario: PacingScenario;
  readonly speed: number;
  readonly latencySeconds: number;
  readonly simSeconds: number;
  readonly wallSeconds: number;
  /** Wall seconds before the sim produced its first tick (the tick-0 hook's latency). */
  readonly startupSeconds: number;
  /** Wall seconds the viewer waited on the sim after playback started. */
  readonly stallSeconds: number;
  readonly totalCalls: number;
  readonly hooksByKind: Readonly<Partial<Record<NarratorHook["kind"], number>>>;
  readonly calls: readonly HookCall[];
  readonly legs: readonly LegReport[];
  readonly decisions: number;
  /** The ship is docked at the hub with no voyage set. */
  readonly completed: boolean;
  /** `narrator.quietTooLongDays` in sim-seconds at the run's `daySeconds` (D76). */
  readonly quietTooLongSeconds: number;
  /** Calls per hour this voyage would spend if repeated back to back at this speed. */
  readonly callsPerHour: number;
}

export interface LoadedContent {
  readonly bundle: ContentBundle;
  readonly config: EffectiveConfig;
  readonly scenarioId: ScenarioDefId;
}

let cachedContent: LoadedContent | undefined;

/** The authored bundle, validated once per process, with the default (first) scenario. */
export function loadPacingContent(): LoadedContent {
  if (cachedContent !== undefined) return cachedContent;
  const result = loadBundle();
  if (!result.ok) {
    const detail = result.issues
      .map((issue) => `[${issue.level}] ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`@crew/content bundle failed validation:\n${detail}`);
  }
  const bundle = result.bundle;
  const scenarioId = Object.keys(bundle.scenarios)[0] as ScenarioDefId | undefined;
  if (scenarioId === undefined) throw new Error("@crew/content bundle has no scenarios");
  cachedContent = { bundle, config: { values: bundle.config, hash: bundle.hash }, scenarioId };
  return cachedContent;
}

/**
 * The full V1 registry in the worker's order (a copy of `apps/web/src/worker/registry.ts`,
 * which the CLI cannot import).
 */
export function createPacingRegistry(): KernelRegistry {
  const registry = createRegistry();
  registerSpatial(registry);
  registerEquipmentSystems(registry);
  registerDirt(registry);
  registerTravel(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerWork(registry, {
    derivations: {
      ...equipmentTaskDerivation,
      ...travelTaskDerivations,
      ...commerceTaskDerivations,
      ...galleyTaskDerivations,
      ...dirtTaskDerivations,
    },
    stages: equipmentStages,
  });
  registerPlannerDefaults(registry);
  return registry;
}

function describeLeg(world: World): string {
  const travel = world.state.travel;
  return travel.stage === "docked" ? travel.portId : `${travel.fromPortId}→${travel.toPortId}`;
}

/** A freight draft hub → far port that passes the path-distance pay band at its minimum. */
export function freightDraft(world: World): Omit<Command, "id"> {
  const itemDefId = Object.values(world.content.items).find(
    (item) => item.cargoClass === "general",
  )?.id;
  if (itemDefId === undefined) throw new Error("no general-cargo item in the bundle");
  const band = world.config.values.commerce.priceBands.general;
  const route = shortestPath(world.content.ports, HUB_PORT_ID, FAR_PORT_ID);
  if (route === undefined) throw new Error(`no path ${HUB_PORT_ID} → ${FAR_PORT_ID}`);
  const count = 2;
  return {
    source: "scenario",
    kind: "offerJob",
    payload: {
      job: {
        issuer: { name: "Pacing Run", role: "dispatcher" },
        description: { key: "pacing.freight", params: {} },
        fromPortId: HUB_PORT_ID,
        toPortId: FAR_PORT_ID,
        cargo: [{ itemDefId, count }],
        pay: Math.ceil(band.min * route.distance * count),
      },
      surface: false,
    },
  };
}

/**
 * D70: the captain has gone ashore at `portId` this docking and the narrator's answer is in (the
 * `captainAshore` ask is recorded and no hook is pending). The script takes work or sets course
 * only then, as a player answering the offer card would; the stub narrator offers nothing.
 */
function askedAt(world: World, portId: PortDefId): boolean {
  const narrator = world.state.narrator;
  return narrator.captainAshoreLastAsk?.portId === portId && narrator.pendingHook === undefined;
}

/**
 * The scripted voyage: a tiny state machine driven from the ship's travel state after each
 * advance. Plain: set course to the far port, and back once docked there. Freight: first offer
 * and accept a hub → far-port job so cargo work happens at both ends.
 */
export class VoyageScript {
  private phase: "offer" | "accept" | "outbound" | "homeward" | "done";
  private jobId: JobId | undefined;

  constructor(
    private readonly scenario: PacingScenario,
    private readonly send: (command: Omit<Command, "id">) => void,
  ) {
    this.phase = scenario === "freight" ? "offer" : "outbound";
  }

  get done(): boolean {
    return this.phase === "done";
  }

  /** Called with the events of the last advance; may queue commands for the next tick. */
  step(world: World, events: readonly { type: string; payload: unknown }[]): void {
    const travel = world.state.travel;
    switch (this.phase) {
      case "offer":
        // D70: the captain walks ashore first, and the narrator is asked; then the work is taken.
        if (!askedAt(world, HUB_PORT_ID)) return;
        this.send(freightDraft(world));
        this.phase = "accept";
        return;
      case "accept": {
        const offered = events.find((e) => e.type === "jobOffered");
        if (offered === undefined) return;
        this.jobId = (offered.payload as { jobId: JobId }).jobId;
        this.send({ source: "scenario", kind: "acceptContract", payload: { jobId: this.jobId } });
        this.phase = "outbound";
        return;
      }
      case "outbound":
        if (travel.stage === "docked" && travel.portId === HUB_PORT_ID) {
          if (travel.plannedDestinationId !== undefined) return;
          if (this.scenario === "plain" && !askedAt(world, HUB_PORT_ID)) return;
          this.setCourse(FAR_PORT_ID);
          return;
        }
        if (travel.stage === "docked" && travel.portId === FAR_PORT_ID) {
          if (!askedAt(world, FAR_PORT_ID)) return;
          this.setCourse(HUB_PORT_ID);
          this.phase = "homeward";
        }
        return;
      case "homeward":
        if (
          travel.stage === "docked" &&
          travel.portId === HUB_PORT_ID &&
          travel.voyageDestinationId === undefined &&
          travel.plannedDestinationId === undefined
        ) {
          this.phase = "done";
        }
        return;
      case "done":
        return;
    }
  }

  private setCourse(destinationPortId: PortDefId): void {
    this.send({ source: "scenario", kind: "setCourse", payload: { destinationPortId } });
  }

  /** The freight job's status at the end of the run, for the report. */
  jobStatus(world: World): string | undefined {
    if (this.jobId === undefined) return undefined;
    return world.state.jobs[this.jobId]?.status;
  }
}

function countByKind(
  calls: readonly { kind: NarratorHook["kind"] }[],
): Partial<Record<NarratorHook["kind"], number>> {
  const counts: Partial<Record<NarratorHook["kind"], number>> = {};
  for (const call of calls) counts[call.kind] = (counts[call.kind] ?? 0) + 1;
  return counts;
}

/**
 * One pacing run at one speed. Deterministic: the kernel is seeded and the wall clock is
 * simulated, so the result is reproducible and the test can assert on it.
 */
export function runPacing(options: PacingOptions, kernel?: Kernel): PacingResult {
  const { bundle, config, scenarioId } = loadPacingContent();
  const k = kernel ?? createKernel(createPacingRegistry());
  const world = k.createWorld(scenarioId, options.seed, bundle, config);
  const tickRate = world.config.values.time.tickRate;
  const msPerTick = 1000 / tickRate;
  const capTicks = Math.round(tickRate * RUN_AHEAD_CAP_SECONDS);
  const speed = options.speed;
  const latencyMs = options.latencySeconds * 1000;

  let commandCount = 0;
  const send = (command: Omit<Command, "id">): void => {
    commandCount += 1;
    const result = k.enqueueCommand(world, {
      ...command,
      id: `cmd:pacing:${commandCount}` as CommandId,
    } as Command);
    if (result.status !== "accepted") {
      throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
    }
  };
  const script = new VoyageScript(options.scenario, send);

  // --- Wall clock and viewer -----------------------------------------------------------------
  let wallMs = 0;
  let viewTick = 0;
  /** Fractional ticks the viewer has earned but not yet consumed (sub-tick precision). */
  let viewRemainderTicks = 0;
  let stallMs = 0;
  let startupMs = 0;
  let viewerStarted = false;

  // --- Host state (mirrors createHost) --------------------------------------------------------
  let accumulatorMs = 0;
  let haltedFor: "hook" | "decision" | undefined;
  let simDone = false;

  // --- Stub narrator ---------------------------------------------------------------------------
  /** The hook awaiting the stub's answer: what `calls` will record, plus its running stall. */
  let pendingCall:
    | {
        kind: NarratorHook["kind"];
        tick: number;
        leg: string;
        lead: number;
        answerDueAtMs: number;
        stallMs: number;
      }
    | undefined;
  const calls: HookCall[] = [];
  let decisions = 0;

  // --- Leg tracking ------------------------------------------------------------------------------
  const legs: LegReport[] = [];
  let lastStage = world.state.travel.stage;
  let legStart: { fromPortId: PortDefId; departedTick: number; firstCall: number } | undefined;

  const lead = (): number => world.state.tick - viewTick;

  function onHalt(kind: "hook" | "decision"): void {
    haltedFor = kind;
    if (kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      pendingCall = {
        kind: hook.kind,
        tick: world.state.tick,
        leg: describeLeg(world),
        lead: lead() / tickRate,
        answerDueAtMs: wallMs + latencyMs,
        stallMs: 0,
      };
    } else {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      decisions += 1;
      send({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: "left" },
      });
    }
  }

  function haltStillHolds(): boolean {
    if (haltedFor === undefined) return false;
    const probe = k.advance(world, 0);
    if (probe.halt.kind === "completed") {
      haltedFor = undefined;
      return false;
    }
    if (probe.halt.kind !== haltedFor) onHalt(probe.halt.kind);
    return true;
  }

  function afterAdvance(events: readonly { type: string; payload: unknown }[]): void {
    const travel = world.state.travel;
    if (lastStage === "docked" && travel.stage !== "docked") {
      legStart = {
        fromPortId: travel.fromPortId,
        departedTick: world.state.tick,
        firstCall: calls.length,
      };
    } else if (lastStage !== "docked" && travel.stage === "docked" && legStart !== undefined) {
      legs.push({
        fromPortId: legStart.fromPortId,
        toPortId: travel.portId,
        departedTick: legStart.departedTick,
        dockedTick: world.state.tick,
        simSeconds: (world.state.tick - legStart.departedTick) / tickRate,
        hooksByKind: countByKind(calls.slice(legStart.firstCall)),
      });
      legStart = undefined;
    }
    lastStage = travel.stage;
    script.step(world, events);
    if (script.done) simDone = true;
  }

  function advanceTicks(ticks: number): void {
    let remaining = ticks;
    while (remaining > 0 && !simDone) {
      const result = k.advance(world, 1);
      remaining -= 1;
      afterAdvance(result.events);
      if (result.halt.kind !== "completed") {
        onHalt(result.halt.kind);
        return;
      }
    }
  }

  function hostLoop(): void {
    if (simDone) return;
    accumulatorMs += LOOP_INTERVAL_MS * speed;

    if (pendingCall !== undefined && wallMs >= pendingCall.answerDueAtMs) {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("answer due without a pending hook");
      send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
      calls.push({
        kind: pendingCall.kind,
        tick: pendingCall.tick,
        tickSeconds: pendingCall.tick / tickRate,
        leg: pendingCall.leg,
        leadSeconds: pendingCall.lead,
        stallSeconds: pendingCall.stallMs / 1000,
      });
      pendingCall = undefined;
    }

    if (haltStillHolds()) {
      accumulatorMs = 0;
      return;
    }
    const ticksWanted = Math.floor(accumulatorMs / msPerTick);
    const budget = Math.max(0, capTicks - lead());
    if (budget <= 0) {
      accumulatorMs = Math.min(accumulatorMs, msPerTick * 4);
      return;
    }
    const ticksToRun = Math.min(budget, Math.max(ticksWanted, BURST_TICKS_PER_LOOP));
    if (ticksToRun <= 0) return;
    accumulatorMs = Math.max(0, accumulatorMs - ticksToRun * msPerTick);
    advanceTicks(ticksToRun);
  }

  function viewerLoop(): void {
    // The initial docking's hook is raised after the first tick completes; until it is answered
    // the sim sits at tick 1 and the player is still on the loading screen.
    if (!viewerStarted) {
      if (world.state.tick <= 1) {
        startupMs += LOOP_INTERVAL_MS;
        return;
      }
      viewerStarted = true;
    }
    viewRemainderTicks += (LOOP_INTERVAL_MS * speed) / msPerTick;
    const wanted = Math.floor(viewRemainderTicks);
    viewRemainderTicks -= wanted;
    const available = world.state.tick - viewTick;
    const advanced = Math.min(wanted, available);
    viewTick += advanced;
    const shortfallMs = ((wanted - advanced) * msPerTick) / speed;
    stallMs += shortfallMs;
    if (pendingCall !== undefined) pendingCall.stallMs += shortfallMs;
  }

  while (!(simDone && viewTick >= world.state.tick)) {
    hostLoop();
    viewerLoop();
    wallMs += LOOP_INTERVAL_MS;
    if (world.state.tick > MAX_SIM_TICKS) {
      throw new Error(
        `pacing run did not complete within ${MAX_SIM_TICKS / tickRate} sim-seconds (at ${describeLeg(world)}, ${legs.length} legs, job ${script.jobStatus(world) ?? "none"})`,
      );
    }
  }

  const travel = world.state.travel;
  const completed =
    travel.stage === "docked" &&
    travel.portId === HUB_PORT_ID &&
    travel.voyageDestinationId === undefined;
  const wallSeconds = wallMs / 1000;
  return {
    scenario: options.scenario,
    speed,
    latencySeconds: options.latencySeconds,
    simSeconds: world.state.tick / tickRate,
    wallSeconds,
    startupSeconds: startupMs / 1000,
    stallSeconds: stallMs / 1000,
    totalCalls: calls.length,
    hooksByKind: countByKind(calls),
    calls,
    legs,
    decisions,
    completed,
    quietTooLongSeconds: daysToSeconds(
      world.config.values,
      world.config.values.narrator.quietTooLongDays,
    ),
    callsPerHour: wallSeconds > 0 ? (calls.length * 3600) / wallSeconds : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface PacingCliOptions {
  readonly speeds: readonly number[];
  readonly latencySeconds: number;
  readonly scenarios: readonly PacingScenario[];
  readonly json: boolean;
  readonly seed: number;
}

export function parsePacingArgs(args: readonly string[]): PacingCliOptions | { error: string } {
  let speeds: readonly number[] = DEFAULT_SPEEDS;
  let latencySeconds = DEFAULT_LATENCY_SECONDS;
  let scenarios: readonly PacingScenario[] = PACING_SCENARIOS;
  let json = false;
  let seed = DEFAULT_SEED;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--speeds": {
        if (value === undefined) return { error: "--speeds needs a list, e.g. 1,4,8" };
        const parsed = value.split(",").map(Number);
        if (parsed.length === 0 || parsed.some((s) => !Number.isFinite(s) || s <= 0)) {
          return { error: `--speeds: bad value "${value}"` };
        }
        speeds = parsed;
        i += 1;
        break;
      }
      case "--latency": {
        const parsed = Number(value);
        if (value === undefined || !Number.isFinite(parsed) || parsed < 0) {
          return { error: `--latency: bad value "${value ?? ""}"` };
        }
        latencySeconds = parsed;
        i += 1;
        break;
      }
      case "--scenario": {
        if (value === "both") {
          scenarios = PACING_SCENARIOS;
        } else if (value === "plain" || value === "freight") {
          scenarios = [value];
        } else {
          return { error: `--scenario: expected plain, freight or both, got "${value ?? ""}"` };
        }
        i += 1;
        break;
      }
      case "--seed": {
        const parsed = Number(value);
        if (value === undefined || !Number.isInteger(parsed)) {
          return { error: `--seed: bad value "${value ?? ""}"` };
        }
        seed = parsed;
        i += 1;
        break;
      }
      default:
        return { error: `unknown option "${arg}"` };
    }
  }
  return { speeds, latencySeconds, scenarios, json, seed };
}

const fmt = (n: number, digits = 1): string => n.toFixed(digits);

const HOOK_COLUMN_ORDER: readonly NarratorHook["kind"][] = [
  "stageDock",
  "captainAshore",
  "quietTooLong",
  "notableEvent",
];

/** The hook kinds that fired in any of `results`, in report order. */
function hookColumns(results: readonly PacingResult[]): NarratorHook["kind"][] {
  return HOOK_COLUMN_ORDER.filter((kind) => results.some((r) => r.hooksByKind[kind] !== undefined));
}

/** One scenario's runs, slowest speed first as given; `sample` is the first. */
interface ScenarioRows {
  readonly scenario: PacingScenario;
  readonly rows: readonly PacingResult[];
  readonly sample: PacingResult;
}

/** The speed table, the legs (speed-independent, from the sample) and the calls at both ends. */
function scenarioSection({ scenario, rows, sample }: ScenarioRows): string[] {
  const kinds = hookColumns(rows);
  const lines = [
    "",
    `## Scenario: ${scenario}`,
    "",
    `| Speed | Sim s | ${kinds.join(" | ")} | Calls | Wall s | Startup s | Stall s | Calls/h | Done |`,
    `|---|---|${kinds.map(() => "---").join("|")}|---|---|---|---|---|---|`,
  ];
  for (const r of rows) {
    const counts = kinds.map((k) => String(r.hooksByKind[k] ?? 0));
    lines.push(
      `| ${r.speed}x | ${fmt(r.simSeconds)} | ${counts.join(" | ")} | ${r.totalCalls} | ${fmt(r.wallSeconds)} | ${fmt(r.startupSeconds)} | ${fmt(r.stallSeconds)} | ${fmt(r.callsPerHour, 0)} | ${r.completed ? "yes" : "NO"} |`,
    );
  }
  lines.push("", "Legs (sim seconds are speed-independent):", "");
  lines.push("| Leg | Sim s | Hooks during leg |", "|---|---|---|");
  for (const leg of sample.legs) {
    const hooks = Object.entries(leg.hooksByKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    lines.push(
      `| ${leg.fromPortId} → ${leg.toPortId} | ${fmt(leg.simSeconds)} | ${hooks || "none"} |`,
    );
  }
  const fastest = rows.at(-1) ?? sample;
  for (const r of fastest === sample ? [sample] : [sample, fastest]) {
    lines.push("", `Calls at ${r.speed}x (sim time, lead in hand when raised, viewer stall):`, "");
    for (const call of r.calls) {
      lines.push(
        `- t=${fmt(call.tickSeconds, 0)}s ${call.kind} at ${call.leg} (lead ${fmt(call.leadSeconds, 0)} s, stall ${fmt(call.stallSeconds)} s)`,
      );
    }
  }
  return lines;
}

/** How one round trip, and back-to-back trips, compare with each hourly narrator cap. */
function budgetLines({ scenario, rows, sample }: ScenarioRows): string[] {
  const lines = HOURLY_CAPS.map((cap) => {
    const verdict = sample.totalCalls <= cap ? "within" : "over";
    return `- ${scenario}: ${sample.totalCalls} calls per round trip is ${verdict} a cap of ${cap}/hour (one trip uses ${fmt((100 * sample.totalCalls) / cap, 0)}% of it).`;
  });
  const perHour = rows.map((r) => `${r.speed}x ≈ ${fmt(r.callsPerHour, 0)}/h`).join(", ");
  lines.push(`- ${scenario}: back-to-back trips would spend ${perHour}.`);
  return lines;
}

/** The markdown report: one table per scenario, a legs table, and the cap comparison. */
export function formatPacingReport(results: readonly PacingResult[]): string {
  const first = results[0];
  if (first === undefined) return "pacing: no results";
  const groups = PACING_SCENARIOS.flatMap((scenario): ScenarioRows[] => {
    const rows = results.filter((r) => r.scenario === scenario);
    const sample = rows[0];
    return sample === undefined ? [] : [{ scenario, rows, sample }];
  });
  return [
    `# Pacing: hub → Ossory Station → hub (latency ${first.latencySeconds} s, quiet window ${Number(first.quietTooLongSeconds.toFixed(1))} s)`,
    ...groups.flatMap(scenarioSection),
    "",
    "## Narrator budget",
    "",
    ...groups.flatMap(budgetLines),
  ].join("\n");
}

export function runPacingCli(args: readonly string[]): { output: string; exitCode: 0 | 1 } {
  const options = parsePacingArgs(args);
  if ("error" in options) {
    return {
      output: `crew pacing: ${options.error} (usage: crew pacing [--speeds 1,2,4,8] [--latency 25] [--scenario plain|freight|both] [--seed 1] [--json])`,
      exitCode: 1,
    };
  }
  const kernel = createKernel(createPacingRegistry());
  const results: PacingResult[] = [];
  for (const scenario of options.scenarios) {
    for (const speed of options.speeds) {
      results.push(
        runPacing(
          { scenario, speed, latencySeconds: options.latencySeconds, seed: options.seed },
          kernel,
        ),
      );
    }
  }
  const allDone = results.every((r) => r.completed);
  const output = options.json ? JSON.stringify(results, null, 2) : formatPacingReport(results);
  return { output, exitCode: allDone ? 0 : 1 };
}
