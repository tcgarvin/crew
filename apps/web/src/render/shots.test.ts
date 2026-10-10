/** Expeditions A1 (§8.6): a tracer plays once from when playback first shows the shot. */
import type { RenderShot, Tick } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { ViewTransform } from "./screen";
import { HIT_FLASH_MS, ShotTracers, TRACER_MS, drawShots } from "./shots";
import { mockCanvas } from "./testCanvas";

function shot(tick: number, toX: number, hit: boolean): RenderShot {
  return { tick: tick as Tick, fromX: 2.5, fromY: 3.5, toX, toY: 6.5, hit };
}

const T: ViewTransform = { scale: 24, offsetX: 10, offsetY: 10 };

describe("ShotTracers", () => {
  it("shows a miss's tracer for TRACER_MS and no flash", () => {
    const tracers = new ShotTracers();
    tracers.note([shot(100, 9, false)], 100);
    expect(tracers.active()).toEqual([{ shot: shot(100, 9, false), tracer: 0, flash: 1 }]);
    tracers.advance(TRACER_MS / 2);
    expect(tracers.active()[0]?.tracer).toBeCloseTo(0.5);
    tracers.advance(TRACER_MS / 2);
    expect(tracers.tracing).toBe(false);
  });

  it("holds a hit's flash after its tracer is gone, for HIT_FLASH_MS", () => {
    const tracers = new ShotTracers();
    tracers.note([shot(100, 9, true)], 100);
    tracers.advance(TRACER_MS);
    const [trace] = tracers.active();
    expect(trace?.tracer).toBe(1);
    expect(trace?.flash).toBeCloseTo(TRACER_MS / HIT_FLASH_MS);
    tracers.advance(HIT_FLASH_MS);
    expect(tracers.tracing).toBe(false);
  });

  it("never replays a shot a later frame still carries", () => {
    const tracers = new ShotTracers();
    tracers.note([shot(100, 9, true)], 100);
    tracers.advance(HIT_FLASH_MS);
    tracers.note([shot(100, 9, true)], 102);
    expect(tracers.tracing).toBe(false);
  });

  it("starts two shots in one tick at different targets, and holds them while paused", () => {
    const tracers = new ShotTracers();
    tracers.note([shot(100, 9, false), shot(100, 4, false)], 100);
    tracers.advance(TRACER_MS / 4);
    tracers.advance(0);
    expect(tracers.active().map((t) => t.tracer)).toEqual([0.25, 0.25]);
  });
});

describe("drawShots", () => {
  it("draws a tracer line for a shot in flight and a ring and core for a hit's flash", () => {
    const tracer = mockCanvas();
    drawShots(tracer.ctx, T, [{ shot: shot(1, 9, false), tracer: 0.3, flash: 1 }], false, 700);
    expect(tracer.calls.get("lineTo")).toBe(1);
    expect(tracer.calls.get("arc") ?? 0).toBe(0);
    const hit = mockCanvas();
    drawShots(hit.ctx, T, [{ shot: shot(1, 9, true), tracer: 1, flash: 0.4 }], true, 700);
    expect(hit.calls.get("lineTo") ?? 0).toBe(0);
    expect(hit.calls.get("arc")).toBe(2);
    expect(hit.calls.get("fill")).toBe(1);
  });

  it("draws nothing with no shot under way", () => {
    const canvas = mockCanvas();
    drawShots(canvas.ctx, T, [], false, 700);
    expect(canvas.calls.size).toBe(0);
  });
});
