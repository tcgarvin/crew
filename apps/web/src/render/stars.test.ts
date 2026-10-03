import { describe, expect, it } from "vitest";
import { STAR_SPEED_PX_PER_SECOND, StarScroll, buildStarField, wrap } from "./stars";

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
