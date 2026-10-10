/**
 * Worker host: owns the kernel and the run-ahead loop (D14, §run-ahead-loop, PLAN §6 W7).
 *
 * Depends only on the `Kernel` interface — never on a concrete kernel implementation, so
 * `sim.worker.ts` is the only file that wires one in. Runnable outside a worker (e.g. in a Vitest
 * test) since `postMessage`/timers/clock are injected.
 *
 * Hooks and decisions (Integration 2): the host halts, posts `hookRaised` / `decisionPending`,
 * and waits. The main thread calls the narrator (it holds the auth token and the network) and
 * answers with ordinary `command` messages — the narrator's commands and then `acknowledgeHook`,
 * or `resolveDecision` for a decision. While halted the loop probes `advance(world, 0)`, which
 * reports whether the halt still holds (a queued acknowledgement or resolution lifts it), so any
 * way of answering resumes the sim.
 */
import type {
  ContentBundle,
  EffectiveConfig,
  EnqueueResult,
  FromWorker,
  Kernel,
  SaveEnvelope,
  ScenarioDefId,
  Tick,
  ToWorker,
  World,
} from "@crew/sim";
import { toAgentViewSnapshot } from "@crew/sim";
import type { weighAgent } from "./weighing";

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
  /** §what-a-crew-member-weighs: what an inspected actor is weighing, in words (`weighAgent`). */
  readonly weigh: typeof weighAgent;
  /** Real-time loop tick, ms. Default 50 (20 Hz), matching `tickRate`. */
  readonly loopIntervalMs?: number;
  /** Sim-seconds of run-ahead allowed beyond the viewer (D14). Default 60. */
  readonly runAheadCapSeconds?: number;
  /**
   * Ticks simulated per loop iteration while run-ahead budget remains (§run-ahead-loop). The loop
   * runs at least this many ticks (more if wall-clock × `speed` wants more) until the cap is
   * reached, so the lead actually builds instead of tracking real time. Default 40: measured ~0.3
   * ms/tick on the default scenario (plus ~0.03 ms per frame), so 40 ticks keeps one iteration
   * under ~15 ms of worker time — 2 sim-seconds per 50 ms loop, filling the 60 s lead in about 1.5
   * s.
   */
  readonly burstTicksPerLoop?: number;
  /**
   * A frame is emitted after every this-many ticks of a burst (§run-ahead-loop), so playback
   * interpolation has enough points to follow walking paths rather than cutting corners across a
   * whole burst. Default 2 (a frame every 100 sim-ms at tickRate 20).
   */
  readonly frameEveryTicks?: number;
  /** How often to snapshot into the view-time ring, in sim-seconds. Default 2. */
  readonly snapshotIntervalSeconds?: number;
  /**
   * §dirt-grid: how often, in sim-seconds, the dirt grid is posted (`host.dirtFrameEverySeconds`):
   * on load, and whenever a burst's tick crosses a multiple of it. Default 5.
   */
  readonly dirtFrameEverySeconds?: number;
  readonly clock?: HostClock;
}

interface RingEntry {
  readonly tick: Tick;
  readonly envelope: SaveEnvelope;
}

export interface Host {
  handleMessage(message: ToWorker): void;
  dispose(): void;
}

export function createHost(deps: HostDeps): Host {
  const clock = deps.clock ?? defaultClock;
  const loopIntervalMs = deps.loopIntervalMs ?? 50;
  const runAheadCapSeconds = deps.runAheadCapSeconds ?? 60;
  const burstTicksPerLoop = Math.max(1, deps.burstTicksPerLoop ?? 40);
  const frameEveryTicks = Math.max(1, deps.frameEveryTicks ?? 2);
  const snapshotIntervalSeconds = deps.snapshotIntervalSeconds ?? 2;
  const dirtFrameEverySeconds = deps.dirtFrameEverySeconds ?? 5;

  let world: World | undefined;
  let tickRate = 20;
  let speed = 1;
  let paused = false;
  /**
   * Set while a hook or decision halts `advance()`; cleared once resolved.
   * §hull-scars-and-ship-loss: `lost` never clears: the ship is gone and the world never steps
   * again.
   */
  let haltedFor: "hook" | "decision" | "lost" | undefined;
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

  function pushSnapshotIfDue(force = false): void {
    if (!world) return;
    const intervalTicks = Math.max(1, Math.round(tickRate * snapshotIntervalSeconds));
    if (force && ring.at(-1)?.tick === world.state.tick) return;
    if (!force && world.state.tick - lastSnapshotTick < intervalTicks && ring.length > 0) return;
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

  /** §dirt-grid: the grime tint's data, keyed by tick; the main thread applies it at `viewTick`. */
  function emitDirtFrame(): void {
    if (!world) return;
    deps.postMessage({ type: "dirt", frame: deps.kernel.getDirtFrame(world) });
  }

  /** Did the ticks `from` (exclusive) to `to` cross a multiple of the dirt cadence? */
  function dirtFrameDue(from: Tick, to: Tick): boolean {
    const every = Math.max(1, Math.round(tickRate * dirtFrameEverySeconds));
    return Math.floor(to / every) > Math.floor(from / every);
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

  function handleHalt(kind: "hook" | "decision" | "lost"): void {
    if (!world) return;
    haltedFor = kind;
    // The halted tick is what the player inspects while a card waits (§offered-freight: an offer's
    // crates appear on the dock on that very tick), so the ring must hold it, not the last due one.
    pushSnapshotIfDue(true);
    if (kind === "lost") {
      // §hull-scars-and-ship-loss: posted once; the halt never lifts, so this branch is not reached
      // again.
      deps.postMessage({ type: "shipLost", tick: world.state.tick });
    } else if (kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook) deps.postMessage({ type: "hookRaised", hook, tick: world.state.tick });
    } else {
      const decisionId = world.state.decisions.queue[0];
      const decision = decisionId ? world.state.decisions.records[decisionId] : undefined;
      if (decision) {
        deps.postMessage({ type: "decisionPending", decision });
      }
    }
  }

  /** Still halted? A queued `acknowledgeHook`/`resolveDecision` for the next tick lifts it. */
  function haltStillHolds(): boolean {
    if (!world || !haltedFor) return false;
    const probe = deps.kernel.advance(world, 0);
    if (probe.halt.kind === "completed") {
      haltedFor = undefined;
      return false;
    }
    if (probe.halt.kind !== haltedFor) {
      // e.g. the hook was answered and the narrator surfaced a decision: announce it.
      handleHalt(probe.halt.kind);
    }
    return true;
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

    if (haltStillHolds()) {
      // Waiting on the narrator/player; don't spend accumulated time we can't use.
      accumulatorMs = 0;
      emitRunAheadStatus();
      return;
    }

    const ticksWanted = Math.floor(accumulatorMs / msPerTick);
    const budget = runAheadBudgetTicks();
    if (budget <= 0) {
      // Capped by run-ahead: hold the accumulated time so we resume smoothly once the viewer
      // catches up, but don't let it grow without bound.
      accumulatorMs = Math.min(accumulatorMs, msPerTick * 4);
      emitRunAheadStatus();
      return;
    }
    // §run-ahead-loop: burst ahead while budget remains; the burst only matters below the cap,
    // where the accumulator alone would merely track wall-clock and never build a lead.
    const ticksToRun = Math.min(budget, Math.max(ticksWanted, burstTicksPerLoop));
    if (ticksToRun <= 0) {
      return;
    }
    // Wall-clock time the burst "pre-spent": never let the accumulator go negative, or the next
    // iterations would owe time back and stall at the cap.
    accumulatorMs = Math.max(0, accumulatorMs - ticksToRun * msPerTick);

    advanceInChunks(ticksToRun);
    emitRunAheadStatus();
  }

  /**
   * Advance `ticks` in sub-chunks of `frameEveryTicks`, emitting a frame after each so playback
   * has evenly spaced interpolation points. Stops early at a halt; `kernel.advance` itself
   * returns at the tick that raises a hook or leaves a decision pending, so a chunk never runs
   * past one.
   */
  function advanceInChunks(ticks: number): void {
    if (!world) return;
    let remaining = ticks;
    while (remaining > 0) {
      const chunk = Math.min(frameEveryTicks, remaining);
      const before = world.state.tick;
      const result = deps.kernel.advance(world, chunk);
      remaining -= chunk;
      if (result.events.length > 0) {
        deps.postMessage({ type: "events", events: result.events });
      }
      if (result.ticksAdvanced > 0) {
        pushSnapshotIfDue();
        emitFrame();
        if (dirtFrameDue(before, world.state.tick)) emitDirtFrame();
      }
      if (result.halt.kind !== "completed") {
        handleHalt(result.halt.kind);
        return;
      }
    }
  }

  /** The ring entry nearest `tick`; with none yet, the requester is told so and gets `undefined`. */
  function ringEntryFor(requestId: string, tick: Tick): RingEntry | undefined {
    const entry = nearestRingEntry(tick);
    if (!entry)
      deps.postMessage({ type: "error", requestId, message: "no snapshot available yet" });
    return entry;
  }

  function handleMessage(message: ToWorker): void {
    switch (message.type) {
      case "load": {
        haltedFor = undefined;
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
          try {
            const restored = deps.kernel.restore(message.source.envelope, deps.content);
            for (const warning of restored.warnings) console.warn(`[host] ${warning}`);
            world = restored;
          } catch (error) {
            // Schema/content-hash mismatch (or any other restore failure, PLAN §3 "Saves"):
            // discard the save and start a new game rather than leaving the world undefined.
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`[host] save incompatible, starting a new game: ${reason}`);
            const fallbackScenarioId = Object.keys(deps.content.scenarios)[0] as
              | ScenarioDefId
              | undefined;
            if (fallbackScenarioId === undefined) throw error;
            world = deps.kernel.createWorld(
              fallbackScenarioId,
              Math.floor(Math.random() * 1_000_000),
              deps.content,
              deps.config,
            );
            deps.postMessage({
              type: "error",
              message: `Save could not be loaded (${reason}); started a new game.`,
            });
          }
        }
        tickRate = world.config.values.time.tickRate;
        // The viewer starts at the loaded tick, so a restored game has its full run-ahead budget
        // immediately rather than waiting for the first `viewProgress` report.
        lastViewTick = world.state.tick;
        lastSnapshotTick = world.state.tick;
        pushSnapshotIfDue();
        emitFrame();
        emitDirtFrame();
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
        const entry = ringEntryFor(message.requestId, message.tick);
        if (!entry) return;
        deps.postMessage({
          type: "snapshot",
          requestId: message.requestId,
          tick: entry.tick,
          state: entry.envelope.state,
        });
        return;
      }
      case "requestAgentView": {
        const entry = ringEntryFor(message.requestId, message.tick);
        if (!entry) return;
        try {
          const snapshotWorld = deps.kernel.restore(entry.envelope, deps.content);
          // Slice-2 QA: the ring holds a snapshot every couple of seconds, so a thought had in
          // between showed up late. Play the copy forward to the tick the viewer tapped at; a
          // halt on that copy (a hook or card) stops it there, which is where the view stood too.
          if (message.tick > entry.tick) {
            deps.kernel.advance(snapshotWorld, message.tick - entry.tick);
          }
          const view = deps.kernel.getAgentView(snapshotWorld, message.actorId);
          deps.postMessage({
            type: "agentViewResult",
            requestId: message.requestId,
            actorId: message.actorId,
            tick: snapshotWorld.state.tick,
            view: toAgentViewSnapshot(view),
            weighing: deps.weigh(view, snapshotWorld, deps.content),
          });
        } catch (error) {
          // Caught so a failed view (e.g. an actor that did not exist at that tick) clears the
          // Inspector instead of throwing out of the worker's `onmessage` handler.
          const reason = error instanceof Error ? error.message : String(error);
          deps.postMessage({ type: "error", requestId: message.requestId, message: reason });
        }
        return;
      }
      default:
        return;
    }
  }

  return { handleMessage, dispose };
}
