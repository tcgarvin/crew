import type {
  PortDefId,
  RenderExpedition,
  RenderFrame,
  RenderImpact,
  RenderShot,
  Tick,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  FramePlayback,
  interpolateFrame,
  interpolateTravel,
  lerp,
  lerpAngle,
  mergeShots,
} from "./playback";

function frame(tick: number, x: number, y: number, facing = 0): RenderFrame {
  return {
    tick,
    actors: [
      {
        id: "a1" as never,
        name: "Mara",
        deckId: "deck" as never,
        x,
        y,
        onDock: false,
        facing,
        actionLabel: "walking",
        passenger: false,
        wounded: false,
      },
    ],
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
    shots: [],
  };
}

/** Non-null indexing helper: `noUncheckedIndexedAccess` + the repo's ban on `!` mean every fixed
 * array access needs an explicit check; these test frames always have exactly one actor. */
function firstActor(f: RenderFrame) {
  const actor = f.actors[0];
  if (!actor) throw new Error("expected at least one actor in the frame");
  return actor;
}

describe("lerp", () => {
  it("interpolates linearly", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 1)).toBe(10);
  });
});

describe("lerpAngle", () => {
  it("takes the short way round a wraparound", () => {
    const result = lerpAngle(-Math.PI + 0.1, Math.PI - 0.1, 0.5);
    // Going the short way from just past -pi to just before +pi should land near +-pi, not 0.
    expect(Math.abs(result)).toBeGreaterThan(Math.PI - 0.3);
  });

  it("interpolates the ordinary case directly", () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4);
  });
});

describe("interpolateFrame", () => {
  it("interpolates matched actor positions", () => {
    const a = frame(100, 0, 0);
    const b = frame(120, 10, 20);
    const mid = interpolateFrame(a, b, 0.5);
    expect(firstActor(mid).x).toBeCloseTo(5);
    expect(firstActor(mid).y).toBeCloseTo(10);
    expect(mid.tick).toBe(110);
  });

  it("clamps t outside [0, 1]", () => {
    const a = frame(0, 0, 0);
    const b = frame(10, 10, 10);
    expect(firstActor(interpolateFrame(a, b, -1)).x).toBe(0);
    expect(firstActor(interpolateFrame(a, b, 2)).x).toBe(10);
  });

  it("passes through an actor missing from the previous frame unchanged", () => {
    const a: RenderFrame = { ...frame(0, 0, 0), actors: [] };
    const b = frame(10, 5, 5);
    const mid = interpolateFrame(a, b, 0.5);
    expect(firstActor(mid)).toEqual(firstActor(b));
  });

  it("snaps group sessions to the next frame (slice 4)", () => {
    const a = frame(0, 0, 0);
    const session = {
      id: "session:1",
      activityId: "activity.cards",
      label: "playing cards",
      x: 7,
      y: 5,
      memberIds: ["a1"],
      running: true,
    } as unknown as RenderFrame["sessions"][number];
    const b: RenderFrame = { ...frame(10, 5, 5), sessions: [session] };
    expect(interpolateFrame(a, b, 0.1).sessions).toEqual([session]);
    expect(interpolateFrame(b, a, 0.1).sessions).toEqual([]);
  });
});

describe("interpolateTravel", () => {
  const HUB = "port.hub" as PortDefId;
  const FARM = "port.farm" as PortDefId;
  const docking = (progress: number, toPortId = FARM) =>
    ({ state: "docking", progress, fromPortId: HUB, toPortId, drifting: false }) as const;

  it("interpolates progress within one stage of one leg, so the berth slides smoothly", () => {
    expect(interpolateTravel(docking(0.2), docking(0.4), 0.5).progress).toBeCloseTo(0.3);
  });

  it("snaps to the next frame across a stage change or a different leg", () => {
    const docked = {
      state: "docked",
      progress: 0,
      fromPortId: FARM,
      toPortId: FARM,
      drifting: false,
    } as const;
    expect(interpolateTravel(docking(0.98), docked, 0.5)).toEqual(docked);
    expect(interpolateTravel(docking(0.9), docking(0.1, HUB), 0.5).progress).toBe(0.1);
  });
});

describe("FramePlayback", () => {
  it("holds on the single buffered frame until a second arrives", () => {
    const playback = new FramePlayback(20);
    playback.push(frame(0, 0, 0));
    const step = playback.advance(1000);
    expect(step?.frame.tick).toBe(0);
    expect(step?.viewTick).toBe(0);
  });

  it("interpolates between two buffered frames over their tick span", () => {
    const playback = new FramePlayback(20); // 50ms/tick
    playback.push(frame(0, 0, 0));
    playback.push(frame(20, 20, 0)); // 1 sim-second later, 1000ms of real playback at speed 1
    const step = playback.advance(500); // halfway through the 1000ms span
    if (!step) throw new Error("expected a playback step");
    expect(firstActor(step.frame).x).toBeCloseTo(10, 0);
    expect(step.viewTick).toBeGreaterThan(0);
    expect(step.viewTick).toBeLessThan(20);
  });

  it("advances faster at higher speed", () => {
    const slow = new FramePlayback(20);
    slow.push(frame(0, 0, 0));
    slow.push(frame(20, 20, 0));
    slow.setSpeed(1);
    const slowStep = slow.advance(250);

    const fast = new FramePlayback(20);
    fast.push(frame(0, 0, 0));
    fast.push(frame(20, 20, 0));
    fast.setSpeed(4);
    const fastStep = fast.advance(250);

    if (!slowStep || !fastStep) throw new Error("expected playback steps");
    expect(firstActor(fastStep.frame).x).toBeGreaterThan(firstActor(slowStep.frame).x);
  });

  it("appends in-order frames and inserts an out-of-order frame at its tick position", () => {
    const playback = new FramePlayback(20);
    playback.push(frame(0, 0, 0));
    playback.push(frame(4, 4, 0));
    playback.push(frame(6, 6, 0));
    playback.push(frame(2, 2, 0)); // late arrival: must slot between ticks 0 and 4
    expect(playback.bufferedFrameCount).toBe(4);
    // Walk the queue: 100ms per 2-tick interval at 20 Hz.
    expect(playback.advance(100)?.frame.tick).toBe(2);
    expect(playback.advance(100)?.frame.tick).toBe(4);
    expect(playback.advance(100)?.frame.tick).toBe(6);
  });

  it("drops a fully consumed interval and holds at the last frame once caught up", () => {
    const playback = new FramePlayback(20);
    playback.push(frame(0, 0, 0));
    playback.push(frame(20, 20, 0));
    const step = playback.advance(5000); // way more than the 1000ms interval
    expect(step?.frame.tick).toBe(20);
    expect(playback.bufferedFrameCount).toBe(1);
  });
});

describe("FramePlayback paused", () => {
  /** A playback a quarter of the way through ticks 0..20, with run-ahead buffered to tick 200. */
  function midway(): FramePlayback {
    const playback = new FramePlayback(20);
    for (let tick = 0; tick <= 200; tick += 20) playback.push(frame(tick, tick, 0));
    playback.advance(250);
    return playback;
  }

  it("holds the picture it was showing however much buffered run-ahead remains", () => {
    const playback = midway();
    const before = playback.advance(0);
    playback.setPaused(true);
    const held = playback.advance(5000);
    expect(held?.viewTick).toBe(before?.viewTick);
    expect(held && firstActor(held.frame).x).toBeCloseTo(5);
    expect(playback.advance(5000)).toBe(held);
    expect(playback.bufferedFrameCount).toBe(11);
  });

  it("resumes from the same view tick, not from where the wall clock got to", () => {
    const playback = midway();
    playback.setPaused(true);
    playback.advance(10_000);
    playback.setPaused(false);
    const resumed = playback.advance(250);
    if (!resumed) throw new Error("expected a playback step");
    expect(resumed.viewTick).toBe(10);
    expect(firstActor(resumed.frame).x).toBeCloseTo(10);
  });

  it("keeps frames that arrive while paused for after the pause", () => {
    const playback = new FramePlayback(20);
    playback.push(frame(0, 0, 0));
    playback.setPaused(true);
    expect(playback.advance(100)?.viewTick).toBe(0);
    playback.push(frame(20, 20, 0));
    expect(playback.advance(1000)?.viewTick).toBe(0);
    playback.setPaused(false);
    expect(playback.advance(500)?.viewTick).toBe(10);
  });

  it("plays at the new speed once resumed when the speed changed during the pause", () => {
    const playback = midway();
    playback.setPaused(true);
    playback.setSpeed(4);
    expect(playback.advance(1000)?.viewTick).toBe(5);
    playback.setPaused(false);
    // 250 ms at 4x is one more sim-second: tick 5 -> 25.
    expect(playback.advance(250)?.viewTick).toBe(25);
  });
});

describe("interpolateFrame and the dock's locals (§local-behaviour)", () => {
  function withLocals(base: RenderFrame, locals: { id: string; x: number; facing: number }[]) {
    return {
      ...base,
      locals: locals.map((l) => ({
        id: l.id as never,
        name: `Local ${l.id}`,
        role: "dock hand",
        deckId: "deck" as never,
        x: l.x,
        y: 2,
        facing: l.facing,
        lookSeed: 7,
        postKey: "dispatch" as never,
        carrying: 0,
      })),
    };
  }

  it("glides a local between frames by id and snaps a newcomer in", () => {
    const prev = withLocals(frame(0, 0, 0), [{ id: "o1", x: 0, facing: 0 }]);
    const next = withLocals(frame(2, 0, 0), [
      { id: "o1", x: 2, facing: Math.PI / 2 },
      { id: "o2", x: 9, facing: 0 },
    ]);
    const mid = interpolateFrame(prev, next, 0.5);
    expect(mid.locals.map((l) => l.id)).toEqual(["o1", "o2"]);
    expect(mid.locals[0]?.x).toBeCloseTo(1);
    expect(mid.locals[0]?.y).toBe(2);
    expect(mid.locals[0]?.facing).toBeCloseTo(Math.PI / 4);
    expect(mid.locals[1]?.x).toBe(9);
  });

  it("drops a local who left in the next frame", () => {
    const prev = withLocals(frame(0, 0, 0), [{ id: "o1", x: 0, facing: 0 }]);
    const next = withLocals(frame(2, 0, 0), []);
    expect(interpolateFrame(prev, next, 0.5).locals).toEqual([]);
  });
});

describe("interpolateFrame and the asteroid field (§rock-impacts)", () => {
  function hit(tick: number, x: number): RenderImpact {
    return { tick: tick as Tick, x, y: 3, rock: "small", tiles: [{ x, y: 3 }] };
  }

  it("snaps the hull, the alert and the field to the next frame", () => {
    const prev = frame(0, 0, 0);
    const next: RenderFrame = {
      ...frame(2, 0, 0),
      hull: { integrity: 92, max: 100, scars: [], lost: false },
      alert: true,
      field: { phase: "active", severity: "heavy", stuck: false },
    };
    const mid = interpolateFrame(prev, next, 0.25);
    expect(mid.hull.integrity).toBe(92);
    expect(mid.alert).toBe(true);
    expect(mid.field).toEqual(next.field);
    // A field that ended drops out at once, like the dock.
    expect(interpolateFrame(next, prev, 0.25).field).toBeUndefined();
  });

  it("keeps both frames' impacts while blending, each once", () => {
    const prev = { ...frame(0, 0, 0), impacts: [hit(0, 1)] };
    const next = { ...frame(2, 0, 0), impacts: [hit(0, 1), hit(2, 5)] };
    expect(interpolateFrame(prev, next, 0.5).impacts).toEqual([hit(0, 1), hit(2, 5)]);
  });

  it("carries the impacts of frames playback skipped onto the frame it shows", () => {
    const playback = new FramePlayback(20);
    playback.push(frame(0, 0, 0));
    playback.push({ ...frame(2, 0, 0), impacts: [hit(2, 1)] });
    playback.push({ ...frame(4, 0, 0), impacts: [hit(4, 2)] });
    playback.push(frame(6, 0, 0));
    playback.push(frame(8, 0, 0));
    // Far enough at once to skip the frames at ticks 0, 2 and 4.
    const step = playback.advance(320);
    expect(step?.viewTick).toBe(6);
    expect(step?.frame.impacts.map((i) => i.tick)).toEqual([2, 4]);
  });
});

describe("interpolateFrame and the fight (expeditions A1, §8.6)", () => {
  function shot(tick: number, toX: number, hit: boolean): RenderShot {
    return { tick: tick as Tick, fromX: 1, fromY: 1, toX, toY: 4, hit };
  }
  const header = (them: RenderExpedition["them"]): RenderExpedition => ({
    phase: "fight",
    us: "steady",
    them,
  });

  it("keeps both frames' shots while blending, each once", () => {
    const prev = { ...frame(0, 0, 0), shots: [shot(0, 3, false)] };
    const next = { ...frame(2, 0, 0), shots: [shot(0, 3, false), shot(2, 5, true)] };
    expect(interpolateFrame(prev, next, 0.5).shots).toEqual([shot(0, 3, false), shot(2, 5, true)]);
    expect(mergeShots([shot(1, 2, true)], [])).toEqual([shot(1, 2, true)]);
  });

  it("snaps the expedition's header to the next frame, and drops it when the next has none", () => {
    const prev = { ...frame(0, 0, 0), expedition: header("steady") };
    const next = { ...frame(2, 0, 0), expedition: header("breaking") };
    expect(interpolateFrame(prev, next, 0.1).expedition?.them).toBe("breaking");
    expect(interpolateFrame(prev, frame(2, 0, 0), 0.1).expedition).toBeUndefined();
  });

  it("carries the shots of frames playback skipped onto the frame it shows", () => {
    const playback = new FramePlayback(20);
    playback.push(frame(0, 0, 0));
    playback.push({ ...frame(2, 0, 0), shots: [shot(2, 3, true)] });
    playback.push({ ...frame(4, 0, 0), shots: [shot(4, 6, false)] });
    playback.push(frame(6, 0, 0));
    playback.push(frame(8, 0, 0));
    const step = playback.advance(320);
    expect(step?.viewTick).toBe(6);
    expect(step?.frame.shots.map((s) => s.tick)).toEqual([2, 4]);
  });
});
