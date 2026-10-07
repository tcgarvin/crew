/** D92 (call 16): an impact flashes once, from when playback first shows it. */
import type { RenderImpact, Tick } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { FLASH_MS, ImpactFlashes, drawImpactFlashes } from "./impacts";
import { mockCanvas } from "./testCanvas";

function impact(tick: number, x: number, y: number, rock: RenderImpact["rock"]): RenderImpact {
  const tiles =
    rock === "small"
      ? [{ x, y }]
      : [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => ({ x: x + dx, y: y + dy })));
  return { tick: tick as Tick, x, y, rock, tiles };
}

describe("ImpactFlashes", () => {
  it("flashes an impact once, for FLASH_MS of real time", () => {
    const flashes = new ImpactFlashes();
    const hit = impact(100, 4, 5, "small");
    flashes.note([hit], 100);
    expect(flashes.active()).toEqual([{ impact: hit, t: 0 }]);
    flashes.advance(FLASH_MS / 2);
    expect(flashes.active()[0]?.t).toBeCloseTo(0.5);
    flashes.advance(FLASH_MS / 2);
    expect(flashes.flashing).toBe(false);
  });

  it("never replays an impact a later frame still carries", () => {
    const flashes = new ImpactFlashes();
    const hit = impact(100, 4, 5, "large");
    flashes.note([hit], 100);
    flashes.advance(FLASH_MS);
    flashes.note([hit], 102);
    expect(flashes.flashing).toBe(false);
  });

  it("starts each of two impacts in one frame, and a second at the same tick elsewhere", () => {
    const flashes = new ImpactFlashes();
    flashes.note([impact(100, 4, 5, "small"), impact(100, 9, 2, "small")], 100);
    expect(flashes.active()).toHaveLength(2);
  });

  it("holds the flash while no time passes (paused)", () => {
    const flashes = new ImpactFlashes();
    flashes.note([impact(100, 4, 5, "small")], 100);
    flashes.advance(FLASH_MS / 4);
    flashes.advance(0);
    expect(flashes.active()[0]?.t).toBeCloseTo(0.25);
  });
});

describe("drawImpactFlashes", () => {
  it("lights every tile of a large rock's blast", () => {
    const canvas = mockCanvas();
    drawImpactFlashes(canvas.ctx, [{ impact: impact(100, 4, 5, "large"), t: 0.3 }], 1 / 24);
    expect(canvas.calls.get("fillRect")).toBe(9);
    expect(canvas.calls.get("stroke")).toBe(1);
  });

  it("draws nothing with no flash under way", () => {
    const canvas = mockCanvas();
    drawImpactFlashes(canvas.ctx, [], 1 / 24);
    expect(canvas.calls.size).toBe(0);
  });
});
