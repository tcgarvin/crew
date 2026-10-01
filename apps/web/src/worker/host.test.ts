import type {
  AdvanceResult,
  Command,
  ContentBundle,
  EffectiveConfig,
  EnqueueResult,
  FromWorker,
  Kernel,
  RestoredWorld,
  ScenarioDefId,
  World,
  WorldState,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { type HostClock, createHost } from "./host";

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
          decisions: { records: {}, queue: [] },
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
            kind: "jobBoard",
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
    getRenderFrame(world) {
      const state = world.state as unknown as { tick: number };
      return {
        tick: state.tick,
        actors: [],
        machines: [],
        doors: [],
        travel: { state: "docked", progress: 0 },
        tickerEvents: [],
        money: 0,
        items: [],
        headline: "",
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

function makeFakeClock(): { clock: HostClock; advance: (ms: number) => void; now: () => number } {
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
    now: () => time,
  };
}

const CONFIG: EffectiveConfig = { values: { time: { tickRate: 20 } } as never, hash: "test" };

describe("createHost run-ahead accumulator", () => {
  it("bursts ahead to the cap, then holds at the cap until viewProgress frees budget", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();
    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      clock,
      loopIntervalMs: 50,
      runAheadCapSeconds: 60, // 1200 ticks
      burstTicksPerLoop: 40,
    });

    host.handleMessage({
      type: "load",
      source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
    });
    messages.length = 0;

    const lastFrameTick = () =>
      messages.filter((m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame").at(-1)
        ?.frame.tick;

    // One 50 ms loop at speed 1 wants 1 tick; the burst runs 40 (D30), far ahead of real time.
    advance(50);
    expect(lastFrameTick()).toBe(40);

    // 30 iterations × 40 ticks = 1200 = the cap; it must not pass it however long we wait.
    for (let i = 0; i < 100; i++) advance(50);
    expect(lastFrameTick()).toBe(1200);
    const statuses = messages.filter(
      (m): m is Extract<FromWorker, { type: "runAheadStatus" }> => m.type === "runAheadStatus",
    );
    expect(statuses.at(-1)?.buffered).toBe(1200);

    // The viewer catches up by 100 ticks: exactly that much budget is refilled, in one burst.
    host.handleMessage({ type: "viewProgress", viewTick: 100 });
    for (let i = 0; i < 10; i++) advance(50);
    expect(lastFrameTick()).toBe(1300);
  });

  it("emits a frame every frameEveryTicks ticks during a burst", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();
    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      clock,
      loopIntervalMs: 50,
      runAheadCapSeconds: 60,
      burstTicksPerLoop: 10,
      frameEveryTicks: 2,
    });

    host.handleMessage({
      type: "load",
      source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
    });
    messages.length = 0;

    advance(50);
    const frameTicks = messages
      .filter((m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame")
      .map((m) => m.frame.tick);
    expect(frameTicks).toEqual([2, 4, 6, 8, 10]);
  });

  it("caps run-ahead at the configured number of sim-seconds ahead of the last reported view tick", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();
    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      clock,
      loopIntervalMs: 50,
      runAheadCapSeconds: 1, // 20 ticks
    });

    host.handleMessage({
      type: "load",
      source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
    });
    host.handleMessage({ type: "viewProgress", viewTick: 0 });

    // Run far more real time than the cap allows; the viewer never catches up.
    for (let i = 0; i < 200; i++) advance(50);

    const frames = messages.filter(
      (m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame",
    );
    const maxTick = Math.max(...frames.map((f) => f.frame.tick));
    expect(maxTick).toBeLessThanOrEqual(20);

    const statuses = messages.filter(
      (m): m is Extract<FromWorker, { type: "runAheadStatus" }> => m.type === "runAheadStatus",
    );
    expect(statuses.at(-1)?.buffered).toBeLessThanOrEqual(20);
  });

  it("resumes advancing once the viewer's reported viewTick frees up run-ahead budget", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();
    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      clock,
      loopIntervalMs: 50,
      runAheadCapSeconds: 1, // 20 ticks
    });

    host.handleMessage({
      type: "load",
      source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
    });
    host.handleMessage({ type: "viewProgress", viewTick: 0 });
    for (let i = 0; i < 100; i++) advance(50); // hits the cap at tick 20 and stays there

    host.handleMessage({ type: "viewProgress", viewTick: 15 });
    for (let i = 0; i < 20; i++) advance(50);

    const frames = messages.filter(
      (m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame",
    );
    const maxTick = Math.max(...frames.map((f) => f.frame.tick));
    expect(maxTick).toBeGreaterThan(20);
    expect(maxTick).toBeLessThanOrEqual(35);
  });
});

describe("createHost hook halt", () => {
  it("stops advancing at a hook, posts hookRaised, and resumes once acknowledgeHook arrives as a command", () => {
    const { kernel } = makeFakeKernel(5);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();

    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      clock,
      loopIntervalMs: 50,
      runAheadCapSeconds: 60,
    });

    host.handleMessage({
      type: "load",
      source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
    });

    for (let i = 0; i < 10; i++) advance(50);

    const hookMessages = messages.filter(
      (m): m is Extract<FromWorker, { type: "hookRaised" }> => m.type === "hookRaised",
    );
    expect(hookMessages).toHaveLength(1);
    expect(hookMessages[0]?.tick).toBe(5);

    const maxFrameTick = () =>
      Math.max(
        ...messages
          .filter((m) => m.type === "frame")
          .map((m) => (m as { frame: { tick: number } }).frame.tick),
      );
    expect(maxFrameTick()).toBe(5);

    // While halted, further real time must not advance the sim, nor re-announce the hook.
    for (let i = 0; i < 20; i++) advance(50);
    expect(maxFrameTick()).toBe(5);
    expect(messages.filter((m) => m.type === "hookRaised")).toHaveLength(1);

    // The main thread answers with the narrator's commands and then the acknowledgement.
    const hookId = hookMessages[0]?.hook.id;
    host.handleMessage({
      type: "command",
      requestId: "r1",
      command: {
        id: "cmd:system:ack:1",
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId },
        targetTick: 6,
      } as Command,
    });
    expect(messages.some((m) => m.type === "commandResult" && m.requestId === "r1")).toBe(true);

    for (let i = 0; i < 10; i++) advance(50);
    expect(maxFrameTick()).toBeGreaterThan(5);
  });

  it("bursts again to rebuild the lead once a hook is answered", () => {
    const { kernel } = makeFakeKernel(5);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();
    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      clock,
      loopIntervalMs: 50,
      runAheadCapSeconds: 60,
      burstTicksPerLoop: 40,
    });

    host.handleMessage({
      type: "load",
      source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
    });
    advance(50); // the burst runs into the hook at tick 5 and stops there
    const hook = messages.find(
      (m): m is Extract<FromWorker, { type: "hookRaised" }> => m.type === "hookRaised",
    );
    expect(hook?.tick).toBe(5);
    messages.length = 0;

    host.handleMessage({
      type: "command",
      requestId: "r1",
      command: {
        id: "cmd:system:ack:1",
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId: hook?.hook.id },
        targetTick: 6,
      } as Command,
    });

    // One loop iteration after the acknowledgement: a full burst, not a single wall-clock tick.
    advance(50);
    const frameTicks = messages
      .filter((m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame")
      .map((m) => m.frame.tick);
    expect(frameTicks.at(-1)).toBe(45);
  });
});
