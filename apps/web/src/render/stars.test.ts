import { describe, expect, it } from "vitest";
import {
  STAR_SPEED_PX_PER_SECOND,
  type StarLayer,
  StarScroll,
  buildStarField,
  drawStars,
  wrap,
} from "./stars";

describe("buildStarField", () => {
  it("is the same field every time, in parallax layers from far to near", () => {
    const a = buildStarField();
    expect(buildStarField()).toEqual(a);
    expect(a.length).toBeGreaterThanOrEqual(2);
    const parallax = a.map((layer) => layer.parallax);
    expect([...parallax].sort((x, y) => x - y)).toEqual(parallax);
    for (const layer of a) {
      for (const star of layer.stars) {
        expect(star.x).toBeGreaterThanOrEqual(0);
        expect(star.x).toBeLessThan(1);
        expect(star.y).toBeGreaterThanOrEqual(0);
        expect(star.y).toBeLessThan(1);
      }
    }
  });
});

describe("StarScroll", () => {
  it("advances with real time times star speed", () => {
    const scroll = new StarScroll();
    scroll.advance(50, 1);
    expect(scroll.offsetPx).toBeCloseTo(STAR_SPEED_PX_PER_SECOND * 0.05);
    scroll.advance(50, 0.5);
    expect(scroll.offsetPx).toBeCloseTo(STAR_SPEED_PX_PER_SECOND * 0.075);
  });

  it("stands still at speed 0 (paused, docked, reduced motion)", () => {
    const scroll = new StarScroll();
    scroll.advance(1000, 0);
    expect(scroll.offsetPx).toBe(0);
  });

  it("caps a long gap so a background tab does not jump the field", () => {
    const scroll = new StarScroll();
    scroll.advance(60_000, 1);
    expect(scroll.offsetPx).toBeCloseTo(STAR_SPEED_PX_PER_SECOND * 0.1);
  });
});

describe("wrap", () => {
  it("wraps into [0, period) from either side", () => {
    expect(wrap(5, 4)).toBe(1);
    expect(wrap(-1, 4)).toBe(3);
    expect(wrap(4, 4)).toBe(0);
  });
});

/** A context that records each `fillRect` as `[x, y, w, h]`. */
function recordingCanvas(): { ctx: CanvasRenderingContext2D; rects: number[][] } {
  const rects: number[][] = [];
  const ctx = {
    fillStyle: "",
    globalAlpha: 1,
    fillRect: (...args: number[]) => rects.push(args),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, rects };
}

describe("drawStars (D72: bow east)", () => {
  const layers: StarLayer[] = [
    { parallax: 1, stars: [{ x: 0.5, y: 0.5, size: 2, brightness: 1 }] },
  ];
  const area = { x: 0, y: 0, width: 400, height: 400 };

  it("streams the field aft, toward −x, as the scroll grows", () => {
    const before = recordingCanvas();
    drawStars(before.ctx, layers, area, 0, 0, 1);
    const after = recordingCanvas();
    drawStars(after.ctx, layers, area, 10, 0, 1);
    expect(before.rects).toHaveLength(1);
    expect(after.rects).toHaveLength(1);
    expect(after.rects[0]?.[0]).toBeCloseTo((before.rects[0]?.[0] ?? 0) - 10);
  });

  it("trails a streak on the star's fore side (+x) at speed", () => {
    const still = recordingCanvas();
    drawStars(still.ctx, layers, area, 0, 0, 1);
    const fast = recordingCanvas();
    drawStars(fast.ctx, layers, area, 0, 1, 1);
    const [dotX, , dotW] = still.rects[0] ?? [];
    const [streakX, , streakW] = fast.rects[0] ?? [];
    expect(streakX).toBe(dotX);
    expect(streakW).toBeGreaterThan(dotW ?? 0);
  });
});
