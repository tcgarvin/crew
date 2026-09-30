/**
 * Worker host: owns the kernel and the run-ahead loop (D14, PLAN §6 W7).
 *
 * Depends only on the `Kernel` interface plus a `Narrator` callback (how the "call the server"
 * step is performed) — never on `mockKernel` directly, so `sim.worker.ts` is the only file that
 * needs to change to swap the mock kernel for the real `@crew/sim` one. Runnable outside a worker
 * (e.g. in a Vitest test) since `postMessage`/timers/clock are injected.
 */
import type {
  Command,
  CommandId,
  ContentBundle,
  EffectiveConfig,
  EnqueueResult,
  FromWorker,
  Kernel,
  NarratorHook,
  SaveEnvelope,
  Tick,
  ToWorker,
  World,
} from "@crew/sim";

/** What the host does when a hook is raised: the real one calls the server; the mock fakes it. */
export type Narrator = (hook: NarratorHook) => Promise<{ readonly commands: readonly Command[] }>;

export interface HostClock {
  now(): number;
  setInterval(cb: () => void, ms: number): number;
  clearInterval(id: number): void;
}

const defaultClock: HostClock = {
  now: () => Date.now(),
  setInterval: (cb, ms) => setInterval(cb, ms) as unknown as number,
  clearInterval: (id) => clearInterval(id),
};

export interface HostDeps {
  readonly kernel: Kernel;
  readonly content: ContentBundle;
  readonly config: EffectiveConfig;
  readonly postMessage: (message: FromWorker) => void;
  readonly narrator: Narrator;
  /** Real-time loop tick, ms. Default 50 (20 Hz), matching `tickRate`. */
  readonly loopIntervalMs?: number;
  /** Sim-seconds of run-ahead allowed beyond the viewer (D14). Default 60. */
  readonly runAheadCapSeconds?: number;
  /** How often to snapshot into the view-time ring, in sim-seconds. Default 2. */
  readonly snapshotIntervalSeconds?: number;
  readonly clock?: HostClock;
}

interface RingEntry {
  readonly tick: Tick;
  readonly envelope: SaveEnvelope;
}

let commandCounter = 0;
function nextHostCommandId(): CommandId {
  commandCounter += 1;
  return `cmd:system:host:${commandCounter}` as CommandId;
}

export interface Host {
  handleMessage(message: ToWorker): void;
  dispose(): void;
}

export function createHost(deps: HostDeps): Host {
  const clock = deps.clock ?? defaultClock;
  const loopIntervalMs = deps.loopIntervalMs ?? 50;
  const runAheadCapSeconds = deps.runAheadCapSeconds ?? 60;
  const snapshotIntervalSeconds = deps.snapshotIntervalSeconds ?? 2;

  let world: World | undefined;
  let tickRate = 20;
  let speed = 1;
  let paused = false;
  /** Set while a hook or decision halts `advance()`; cleared once resolved. */
  let haltedFor: "hook" | "decision" | undefined;
  let lastViewTick: Tick | undefined;
  let accumulatorMs = 0;
  let lastLoopAt = clock.now();
  let lastSnapshotTick: Tick = 0;
  const ring: RingEntry[] = [];
  const ringMaxAgeTicks = () => tickRate * runAheadCapSeconds * 3;

  const intervalId = clock.setInterval(loop, loopIntervalMs);

  function dispose(): void {
    clock.clearInterval(intervalId);
  }

  function pushSnapshotIfDue(): void {
    if (!world) return;
    const intervalTicks = Math.max(1, Math.round(tickRate * snapshotIntervalSeconds));
    if (world.state.tick - lastSnapshotTick < intervalTicks && ring.length > 0) return;
    lastSnapshotTick = world.state.tick;
    const envelope = deps.kernel.serialize(world);
    ring.push({ tick: world.state.tick, envelope });
    const cutoff = world.state.tick - ringMaxAgeTicks();
    while (ring.length > 1 && (ring[0]?.tick ?? Number.POSITIVE_INFINITY) < cutoff) {
      ring.shift();
    }
  }

  function nearestRingEntry(tick: Tick): RingEntry | undefined {
    let best: RingEntry | undefined;
    for (const entry of ring) {
      if (entry.tick <= tick) {
        best = entry;
      } else {
        break;
      }
    }
    return best ?? ring[0];
  }

  function emitFrame(): void {
    if (!world) return;
    deps.postMessage({ type: "frame", frame: deps.kernel.getRenderFrame(world) });
  }

  function emitRunAheadStatus(): void {
    if (!world) return;
    deps.postMessage({
      type: "runAheadStatus",
      simTick: world.state.tick,
      buffered: Math.max(0, world.state.tick - (lastViewTick ?? world.state.tick)),
      ...(lastViewTick !== undefined ? { viewTick: lastViewTick } : {}),
    });
  }

  function runAheadBudgetTicks(): number {
    const viewTick = lastViewTick ?? 0;
    const capTicks = Math.round(tickRate * runAheadCapSeconds);
    if (!world) return 0;
    return Math.max(0, capTicks - (world.state.tick - viewTick));
  }

  function handleHalt(kind: "hook" | "decision"): void {
    if (!world) return;
    haltedFor = kind;
    if (kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (!hook) return;
      deps.postMessage({ type: "hookRaised", hook, tick: world.state.tick });
      void resolveHook(hook.id, hook);
    } else {
      const decisionId = world.state.decisions.queue[0];
      const decision = decisionId ? world.state.decisions.records[decisionId] : undefined;
      if (decision) {
        deps.postMessage({ type: "decisionPending", decision });
      }
    }
  }

  async function resolveHook(hookId: NarratorHook["id"], hook: NarratorHook): Promise<void> {
    const response = await deps.narrator(hook);
    if (!world) return;
    for (const draft of response.commands) {
      deps.kernel.enqueueCommand(world, {
        ...draft,
        id: nextHostCommandId(),
        targetTick: world.state.tick,
      } as Command);
    }
    deps.kernel.enqueueCommand(world, {
      id: nextHostCommandId(),
      source: "system",
      kind: "acknowledgeHook",
      payload: { hookId },
      targetTick: world.state.tick,
    } as Command);
    haltedFor = undefined;
    // A decision may now be queued (from the narrator's `surfaceDecision`); let the loop notice.
  }

  function loop(): void {
    if (!world || paused) {
      lastLoopAt = clock.now();
      return;
    }
    const now = clock.now();
    const elapsedMs = now - lastLoopAt;
    lastLoopAt = now;
    accumulatorMs += elapsedMs * speed;
    const msPerTick = 1000 / tickRate;

    if (haltedFor) {
      // Waiting on the narrator/player; don't spend accumulated time we can't use.
      accumulatorMs = 0;
      emitRunAheadStatus();
      return;
    }

    const ticksWanted = Math.floor(accumulatorMs / msPerTick);
    if (ticksWanted <= 0) {
      return;
    }
    const budget = runAheadBudgetTicks();
    const ticksToRun = Math.min(ticksWanted, budget);
    if (ticksToRun <= 0) {
      // Capped by run-ahead: hold the accumulated time so we resume smoothly once the viewer
      // catches up, but don't let it grow without bound.
      accumulatorMs = Math.min(accumulatorMs, msPerTick * 4);
      emitRunAheadStatus();
      return;
    }
    accumulatorMs -= ticksToRun * msPerTick;

    const result = deps.kernel.advance(world, ticksToRun);
    if (result.events.length > 0) {
      deps.postMessage({ type: "events", events: result.events });
    }
    if (result.ticksAdvanced > 0) {
      pushSnapshotIfDue();
      emitFrame();
    }
    if (result.halt.kind !== "completed") {
      handleHalt(result.halt.kind);
    }
    emitRunAheadStatus();
  }

  function handleMessage(message: ToWorker): void {
    switch (message.type) {
      case "load": {
        haltedFor = undefined;
        lastViewTick = undefined;
        accumulatorMs = 0;
        lastLoopAt = clock.now();
        ring.length = 0;
        if (message.source.kind === "scenario") {
          world = deps.kernel.createWorld(
            message.source.scenarioId,
            message.source.seed,
            deps.content,
            deps.config,
          );
        } else {
          world = deps.kernel.restore(message.source.envelope, deps.content);
        }
        tickRate = world.config.values.time.tickRate;
        lastSnapshotTick = world.state.tick;
        pushSnapshotIfDue();
        emitFrame();
        emitRunAheadStatus();
        return;
      }
      case "setSpeed":
        speed = message.speed;
        return;
      case "pause":
        paused = true;
        return;
      case "resume":
        paused = false;
        lastLoopAt = clock.now();
        return;
      case "viewProgress":
        lastViewTick = message.viewTick;
        return;
      case "command": {
        if (!world) return;
        const result: EnqueueResult = deps.kernel.enqueueCommand(world, message.command);
        deps.postMessage({ type: "commandResult", requestId: message.requestId, result });
        return;
      }
      case "requestSave": {
        if (!world) return;
        const envelope = deps.kernel.serialize(world);
        deps.postMessage({ type: "saveBlob", requestId: message.requestId, envelope });
        return;
      }
      case "requestSnapshotAt": {
        const entry = nearestRingEntry(message.tick);
        if (!entry) {
          deps.postMessage({
            type: "error",
            requestId: message.requestId,
            message: "no snapshot available yet",
          });
          return;
        }
        deps.postMessage({
          type: "snapshot",
          requestId: message.requestId,
          tick: entry.tick,
          state: entry.envelope.state,
        });
        return;
      }
      case "requestAgentView": {
        const entry = nearestRingEntry(message.tick);
        if (!entry) {
          deps.postMessage({
            type: "error",
            requestId: message.requestId,
            message: "no snapshot available yet",
          });
          return;
        }
        const snapshotWorld = deps.kernel.restore(entry.envelope, deps.content);
        const view = deps.kernel.getAgentView(snapshotWorld, message.actorId);
        deps.postMessage({
          type: "agentViewResult",
          requestId: message.requestId,
          actorId: message.actorId,
          tick: entry.tick,
          view: {
            tick: view.tick,
            self: view.self,
            facts: view.facts(),
            problems: view.knownProblems(),
            tasks: view.knownTasks(),
            roster: view.roster(),
          },
        });
        return;
      }
      default:
        return;
    }
  }

  return { handleMessage, dispose };
}
