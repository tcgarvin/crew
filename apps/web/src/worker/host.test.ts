import type {
  AdvanceResult,
  Command,
  ContentBundle,
  EffectiveConfig,
  EnqueueResult,
  FromWorker,
  Kernel,
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
      }) as World,
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
  it("advances roughly tickRate * speed ticks per second and reports run-ahead status", () => {
    const { kernel } = makeFakeKernel(Number.POSITIVE_INFINITY);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();
    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      narrator: async () => ({ commands: [] }),
      clock,
      loopIntervalMs: 50,
      runAheadCapSeconds: 60,
    });

    host.handleMessage({
      type: "load",
      source: { kind: "scenario", scenarioId: "s" as ScenarioDefId, seed: 1 },
    });
    messages.length = 0;

    // 1 real second at speed 1, tickRate 20 => ~20 ticks.
    for (let i = 0; i < 20; i++) advance(50);

    const frames = messages.filter(
      (m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame",
    );
    const lastFrame = frames.at(-1);
    expect(lastFrame?.frame.tick).toBeGreaterThanOrEqual(18);
    expect(lastFrame?.frame.tick).toBeLessThanOrEqual(21);
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
      narrator: async () => ({ commands: [] }),
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
      narrator: async () => ({ commands: [] }),
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
  it("stops advancing at a hook, posts hookRaised, then resumes once the narrator resolves and acknowledgeHook is enqueued", async () => {
    const { kernel } = makeFakeKernel(5);
    const messages: FromWorker[] = [];
    const { clock, advance } = makeFakeClock();
    let resolveNarrator: (() => void) | undefined;
    const narratorCalls: number[] = [];

    const host = createHost({
      kernel,
      content: {} as ContentBundle,
      config: CONFIG,
      postMessage: (m) => messages.push(m),
      narrator: (hook) => {
        narratorCalls.push(hook.tick);
        return new Promise<{ commands: Command[] }>((resolve) => {
          resolveNarrator = () => resolve({ commands: [] });
        });
      },
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
    expect(narratorCalls).toEqual([5]);

    const frames = messages.filter(
      (m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame",
    );
    expect(Math.max(...frames.map((f) => f.frame.tick))).toBe(5);

    // While halted, further real time must not advance the sim.
    for (let i = 0; i < 20; i++) advance(50);
    expect(
      Math.max(
        ...messages
          .filter((m) => m.type === "frame")
          .map((m) => (m as { frame: { tick: number } }).frame.tick),
      ),
    ).toBe(5);

    resolveNarrator?.();
    await Promise.resolve();
    await Promise.resolve();

    for (let i = 0; i < 10; i++) advance(50);
    const framesAfter = messages.filter(
      (m): m is Extract<FromWorker, { type: "frame" }> => m.type === "frame",
    );
    expect(Math.max(...framesAfter.map((f) => f.frame.tick))).toBeGreaterThan(5);
  });
});
