import type {
  AdvanceResult,
  Command,
  ContentBundle,
  DeckDefId,
  EffectiveConfig,
  EnqueueResult,
  FromWorker,
  Kernel,
  PortDefId,
  RestoredWorld,
  ScenarioDefId,
  ToWorker,
  World,
  WorldState,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { type HostClock, type HostDeps, createHost } from "./host";

/**
 * A tiny fake `Kernel` purpose-built for exercising `host.ts`'s run-ahead accumulator and
 * hook/decision halt handling in isolation from the mock kernel's own timing constants (40s hook
 * cadence, etc.) — one sim-tick = one call to `advance(world, 1)`; `advance` never batches, so
 * the test can assert exactly how many ticks the host asks for per loop iteration.
 */
function makeFakeKernel(hookAtTick: number) {
  const hooksRaised: number[] = [];
  const kernel: Kernel = {
    createWorld(_scenarioId, _seed, _content, config): World {
      return {
        state: {
          tick: 0,
          narrator: {
            pendingHook: undefined,
            lastNarrativeTick: 0,
            budget: { spawnsRemaining: 0, faultsRemaining: 0 },
            recentHookIds: [],
          },
          decisions: { records: {}, queue: [], held: [] },
        } as unknown as WorldState,
        caches: {} as World["caches"],
        content: {} as ContentBundle,
        config,
      };
    },
    advance(world, ticks): AdvanceResult {
      const state = world.state as unknown as {
        tick: number;
        narrator: {
          pendingHook: { id: string; kind: string; context: unknown; tick: number } | undefined;
        };
      };
      if (state.narrator.pendingHook) {
        return { events: [], ticksAdvanced: 0, halt: { kind: "hook" } };
      }
      let advanced = 0;
      for (; advanced < ticks; advanced++) {
        state.tick += 1;
        if (state.tick === hookAtTick) {
          state.narrator.pendingHook = {
            id: `k${state.tick}`,
            kind: "captainAshore",
            context: {},
            tick: state.tick,
          };
          hooksRaised.push(state.tick);
          advanced += 1;
          return { events: [], ticksAdvanced: advanced, halt: { kind: "hook" } };
        }
      }
      return { events: [], ticksAdvanced: advanced, halt: { kind: "completed" } };
    },
    enqueueCommand(world, command): EnqueueResult {
      const state = world.state as unknown as {
        narrator: { pendingHook: { id: string } | undefined };
      };
      if (command.kind === "acknowledgeHook") {
        state.narrator.pendingHook = undefined;
        return { status: "accepted", commandId: command.id, applyAtTick: 0 };
      }
      return { status: "accepted", commandId: command.id, applyAtTick: 0 };
    },
    getAgentView: () => {
      throw new Error("not used in this test");
    },
    getDirtFrame(world) {
      const state = world.state as unknown as { tick: number };
      return {
        tick: state.tick,
        deckId: "deck.test" as DeckDefId,
        width: 2,
        height: 1,
        cells: Uint8Array.from([0, 0]),
        tiers: {},
      };
    },
    getRenderFrame(world) {
      const state = world.state as unknown as { tick: number };
      return {
        tick: state.tick,
        actors: [],
        machines: [],
        doors: [],
        travel: {
          state: "docked",
          progress: 0,
          fromPortId: "port.test" as PortDefId,
          toPortId: "port.test" as PortDefId,
          drifting: false,
        },
        tickerEvents: [],
        money: 0,
        items: [],
        headline: "",
        locals: [],
        dockProps: [],
        sessions: [],
        hull: { integrity: 100, max: 100, scars: [], lost: false },
        alert: false,
        impacts: [],
      };
    },
    serialize: (world) =>
      ({
        schemaVersion: 1,
        simVersion: "test",
        contentHash: "test",
        configHash: "test",
        savedAtTick: (world.state as unknown as { tick: number }).tick,
        config: world.config.values,
        state: structuredClone(world.state),
      }) as never,
    restore: (envelope) =>
      ({
        state: structuredClone(envelope.state),
        caches: {} as World["caches"],
        content: {} as ContentBundle,
        config: { values: envelope.config, hash: envelope.configHash },
        warnings: [],
      }) as RestoredWorld,
  };
  return { kernel, hooksRaised };
}

function makeFakeClock(): { clock: HostClock; advance: (ms: number) => void } {
  let time = 0;
  let callback: (() => void) | undefined;
  return {
    clock: {
      now: () => time,
      setInterval: (cb) => {
        callback = cb;
        return 1;
      },
      clearInterval: () => {
        callback = undefined;
      },
    },
    advance(ms: number) {
      time += ms;
      callback?.();
    },
  };
}

const CONFIG: EffectiveConfig = { values: { time: { tickRate: 20 } } as never, hash: "test" };

type HostOptions = Omit<
  HostDeps,
  "kernel" | "content" | "config" | "postMessage" | "clock" | "weigh"
>;

/**
 * A host on `kernel` with a fake clock and a 50 ms loop, a scenario already loaded, and every
 * message it posts collected in `messages`.
 */
function startHost(kernel: Kernel, options: HostOptions) {
  const messages: FromWorker[] = [];
  const { clock, advance } = makeFakeClock();
  const host = createHost({
    kernel,
    content: {} as ContentBundle,
    config: CONFIG,
    postMessage: (m) => messages.push(m),
    weigh: () => ({ verdict: "nothing to do", options: [], ruledOut: [] }),
    clock,
    loopIntervalMs: 50,
    ...options,
  });
  host.handleMessage({
    type: "load",
    source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
  });
  return { host, messages, advance };
}

function ofType<T extends FromWorker["type"]>(
  messages: readonly FromWorker[],
  type: T,
): Extract<FromWorker, { type: T }>[] {
  return messages.filter((m): m is Extract<FromWorker, { type: T }> => m.type === type);
}

function frameTicks(messages: readonly FromWorker[]): number[] {
  return ofType(messages, "frame").map((m) => m.frame.tick);
}

/** The main thread's acknowledgement of a hook, as request `r1`. */
function acknowledgeHook(hookId: string | undefined): ToWorker {
  return {
    type: "command",
    requestId: "r1",
    command: {
      id: "cmd:system:ack:1",
      source: "system",
      kind: "acknowledgeHook",
      payload: { hookId },
      targetTick: 6,
    } as Command,
  };
}

describe("createHost run-ahead accumulator", () => {
  it("bursts ahead to the cap, then holds at the cap until viewProgress frees budget", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const { host, messages, advance } = startHost(kernel, {
      runAheadCapSeconds: 60, // 1200 ticks
      burstTicksPerLoop: 40,
    });
    messages.length = 0;

    const lastFrameTick = () => frameTicks(messages).at(-1);

    // One 50 ms loop at speed 1 wants 1 tick; the burst runs 40 (D30), far ahead of real time.
    advance(50);
    expect(lastFrameTick()).toBe(40);

    // 30 iterations × 40 ticks = 1200 = the cap; it must not pass it however long we wait.
    for (let i = 0; i < 100; i++) advance(50);
    expect(lastFrameTick()).toBe(1200);
    expect(ofType(messages, "runAheadStatus").at(-1)?.buffered).toBe(1200);

    // The viewer catches up by 100 ticks: exactly that much budget is refilled, in one burst.
    host.handleMessage({ type: "viewProgress", viewTick: 100 });
    for (let i = 0; i < 10; i++) advance(50);
    expect(lastFrameTick()).toBe(1300);
  });

  it("emits a frame every frameEveryTicks ticks during a burst", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const { messages, advance } = startHost(kernel, {
      runAheadCapSeconds: 60,
      burstTicksPerLoop: 10,
      frameEveryTicks: 2,
    });
    messages.length = 0;

    advance(50);
    expect(frameTicks(messages)).toEqual([2, 4, 6, 8, 10]);
  });

  it("caps run-ahead at the configured number of sim-seconds ahead of the last reported view tick", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const { host, messages, advance } = startHost(kernel, {
      runAheadCapSeconds: 1, // 20 ticks
    });
    host.handleMessage({ type: "viewProgress", viewTick: 0 });

    // Run far more real time than the cap allows; the viewer never catches up.
    for (let i = 0; i < 200; i++) advance(50);

    expect(Math.max(...frameTicks(messages))).toBeLessThanOrEqual(20);
    expect(ofType(messages, "runAheadStatus").at(-1)?.buffered).toBeLessThanOrEqual(20);
  });

  it("resumes advancing once the viewer's reported viewTick frees up run-ahead budget", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const { host, messages, advance } = startHost(kernel, {
      runAheadCapSeconds: 1, // 20 ticks
    });
    host.handleMessage({ type: "viewProgress", viewTick: 0 });
    for (let i = 0; i < 100; i++) advance(50); // hits the cap at tick 20 and stays there

    host.handleMessage({ type: "viewProgress", viewTick: 15 });
    for (let i = 0; i < 20; i++) advance(50);

    const maxTick = Math.max(...frameTicks(messages));
    expect(maxTick).toBeGreaterThan(20);
    expect(maxTick).toBeLessThanOrEqual(35);
  });
});

/**
 * D37: a kernel that raises a `policyDecision` hook for a queued decision at `hookAtTick`; the
 * decision halt only shows once the hook is acknowledged (as `haltReason` orders it).
 */
function makePolicyKernel(hookAtTick: number): Kernel {
  const base = makeFakeKernel(Number.POSITIVE_INFINITY).kernel;
  type FakeState = {
    tick: number;
    narrator: {
      pendingHook: { id: string; kind: string; context: unknown; tick: number } | undefined;
    };
    decisions: { records: Record<string, unknown>; queue: string[] };
  };
  const halt = (state: FakeState): AdvanceResult["halt"] => {
    if (state.narrator.pendingHook) return { kind: "hook" };
    if (state.decisions.queue.length > 0) return { kind: "decision" };
    return { kind: "completed" };
  };
  return {
    ...base,
    advance(world, ticks): AdvanceResult {
      const state = world.state as unknown as FakeState;
      let advanced = 0;
      while (advanced < ticks && halt(state).kind === "completed") {
        state.tick += 1;
        advanced += 1;
        if (state.tick === hookAtTick) {
          const decisionId = "d1";
          state.decisions.records[decisionId] = {
            id: decisionId,
            origin: "policy",
            prompt: { key: "travel.departureGate", params: {} },
            createdTick: state.tick,
          };
          state.decisions.queue.push(decisionId);
          state.narrator.pendingHook = {
            id: `k${state.tick}`,
            kind: "policyDecision",
            context: { decisionId },
            tick: state.tick,
          };
        }
      }
      return { events: [], ticksAdvanced: advanced, halt: halt(state) };
    },
    enqueueCommand(world, command): EnqueueResult {
      const state = world.state as unknown as FakeState;
      if (command.kind === "acknowledgeHook") state.narrator.pendingHook = undefined;
      if (command.kind === "resolveDecision") state.decisions.queue.shift();
      return { status: "accepted", commandId: command.id, applyAtTick: 0 };
    },
  };
}

describe("createHost dirt channel (D82)", () => {
  it("posts a dirt frame on load and whenever a burst crosses a multiple of the cadence", () => {
    const { kernel } = makeFakeKernel(10_000);
    // 40 ticks a loop, 2 s of sim; the cadence is 3 s (60 ticks), so frames at 0, 60, 120, …
    const { messages, advance } = startHost(kernel, {
      burstTicksPerLoop: 40,
      runAheadCapSeconds: 60,
      dirtFrameEverySeconds: 3,
    });
    expect(ofType(messages, "dirt").map((m) => m.frame.tick)).toEqual([0]);
    advance(50);
    advance(50);
    advance(50);
    expect(ofType(messages, "dirt").map((m) => m.frame.tick)).toEqual([0, 60, 120]);
    const last = ofType(messages, "dirt").at(-1)?.frame;
    expect(last?.cells).toBeInstanceOf(Uint8Array);
    expect(last?.width).toBe(2);
  });
});

describe("createHost policy decision (D37)", () => {
  it("posts hookRaised for the policy hook, then decisionPending only once it is acknowledged", () => {
    const { host, messages, advance } = startHost(makePolicyKernel(5), { runAheadCapSeconds: 60 });

    for (let i = 0; i < 10; i++) advance(50);
    const kinds = () =>
      messages.filter((m) => m.type === "hookRaised" || m.type === "decisionPending");
    expect(kinds().map((m) => m.type)).toEqual(["hookRaised"]);
    const hook = ofType(messages, "hookRaised")[0];
    expect(hook?.hook).toMatchObject({ kind: "policyDecision", context: { decisionId: "d1" } });

    // The main thread answers (with the card prose in hand) and acknowledges.
    host.handleMessage(acknowledgeHook(hook?.hook.id));
    for (let i = 0; i < 5; i++) advance(50);
    expect(kinds().map((m) => m.type)).toEqual(["hookRaised", "decisionPending"]);
    expect(ofType(messages, "decisionPending")[0]?.decision.id).toBe("d1");

    // Resolving the decision resumes the sim; nothing is re-announced.
    host.handleMessage({
      type: "command",
      requestId: "r2",
      command: {
        id: "cmd:player:1",
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: "d1", side: "left" },
        targetTick: 6,
      } as Command,
    });
    for (let i = 0; i < 10; i++) advance(50);
    expect(kinds()).toHaveLength(2);
    expect(Math.max(...frameTicks(messages))).toBeGreaterThan(5);
    host.dispose();
  });
});

describe("createHost hook halt", () => {
  it("stops advancing at a hook, posts hookRaised, and resumes once acknowledgeHook arrives as a command", () => {
    const { kernel } = makeFakeKernel(5);
    const { host, messages, advance } = startHost(kernel, { runAheadCapSeconds: 60 });

    for (let i = 0; i < 10; i++) advance(50);

    const hookMessages = ofType(messages, "hookRaised");
    expect(hookMessages).toHaveLength(1);
    expect(hookMessages[0]?.tick).toBe(5);

    const maxFrameTick = () => Math.max(...frameTicks(messages));
    expect(maxFrameTick()).toBe(5);

    // While halted, further real time must not advance the sim, nor re-announce the hook.
    for (let i = 0; i < 20; i++) advance(50);
    expect(maxFrameTick()).toBe(5);
    expect(ofType(messages, "hookRaised")).toHaveLength(1);

    // The main thread answers with the narrator's commands and then the acknowledgement.
    host.handleMessage(acknowledgeHook(hookMessages[0]?.hook.id));
    expect(messages.some((m) => m.type === "commandResult" && m.requestId === "r1")).toBe(true);

    for (let i = 0; i < 10; i++) advance(50);
    expect(maxFrameTick()).toBeGreaterThan(5);
  });

  it("snapshots the halted tick, so what the frame shows at a hook can be inspected", () => {
    const { kernel } = makeFakeKernel(5);
    const { host, messages, advance } = startHost(kernel, { runAheadCapSeconds: 60 });
    for (let i = 0; i < 10; i++) advance(50);
    expect(messages.some((m) => m.type === "hookRaised")).toBe(true);
    host.handleMessage({ type: "requestSnapshotAt", requestId: "s1", tick: 5 as never });
    const reply = ofType(messages, "snapshot").find((m) => m.requestId === "s1");
    expect(reply?.tick).toBe(5);
  });

  it("bursts again to rebuild the lead once a hook is answered", () => {
    const { kernel } = makeFakeKernel(5);
    const { host, messages, advance } = startHost(kernel, {
      runAheadCapSeconds: 60,
      burstTicksPerLoop: 40,
    });
    advance(50); // the burst runs into the hook at tick 5 and stops there
    const hook = ofType(messages, "hookRaised")[0];
    expect(hook?.tick).toBe(5);
    messages.length = 0;

    host.handleMessage(acknowledgeHook(hook?.hook.id));

    // One loop iteration after the acknowledgement: a full burst, not a single wall-clock tick.
    advance(50);
    expect(frameTicks(messages).at(-1)).toBe(45);
  });
});

describe("createHost agent view (slice-2 QA)", () => {
  /** The fake kernel with an agent view that reports the tick of the world it was taken on. */
  function viewingKernel(hookAtTick: number): Kernel {
    const { kernel } = makeFakeKernel(hookAtTick);
    return {
      ...kernel,
      getAgentView: (world) =>
        ({
          tick: world.state.tick,
          self: {},
          facts: () => [],
          knownProblems: () => [],
          knownTasks: () => [],
          roster: () => [],
          sessions: () => [],
          alert: () => undefined,
        }) as never,
    };
  }

  const ask = (tick: number): ToWorker => ({
    type: "requestAgentView",
    requestId: `v${tick}`,
    actorId: "actor:mara" as never,
    tick: tick as never,
  });

  it("answers at the tick asked for, not the snapshot before it", () => {
    const { host, messages, advance } = startHost(viewingKernel(10_000), {
      runAheadCapSeconds: 60,
      snapshotIntervalSeconds: 2,
    });
    for (let i = 0; i < 5; i++) advance(50);
    host.handleMessage(ask(57));
    const reply = ofType(messages, "agentViewResult").find((m) => m.requestId === "v57");
    expect(reply?.tick).toBe(57);
    expect(reply?.view.tick).toBe(57);
  });

  it("stops at a halt on the way, where the view stood too", () => {
    const { host, messages, advance } = startHost(viewingKernel(30), {
      runAheadCapSeconds: 60,
      snapshotIntervalSeconds: 2,
    });
    advance(50);
    host.handleMessage(ask(35));
    const reply = ofType(messages, "agentViewResult").find((m) => m.requestId === "v35");
    expect(reply?.tick).toBeLessThanOrEqual(30);
  });
});
