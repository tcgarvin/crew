import type { RenderFrame } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { FramePlayback, interpolateFrame, lerp, lerpAngle } from "./playback";

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
        facing,
        actionLabel: "walking",
        passenger: false,
      },
    ],
    machines: [],
    doors: [],
    travel: { state: "docked", progress: 0 },
    tickerEvents: [],
    money: 0,
    items: [],
    headline: "",
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
