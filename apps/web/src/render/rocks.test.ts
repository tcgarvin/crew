/** D92 (call 16): the rock layers, their fade with the field's phase, and their stillness when stuck. */
import type { RenderField } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  FADE_IN_ACTIVE_MS,
  FADE_IN_NEAR_MS,
  FADE_OUT_MS,
  RockFade,
  type RockPaint,
  buildRockField,
  drawRockLayer,
  fadeTarget,
  rockScrollSpeed,
  rocksShown,
} from "./rocks";
import { mockCanvas } from "./testCanvas";

const near: RenderField = { phase: "near", severity: "heavy", stuck: false };
const active: RenderField = { phase: "active", severity: "heavy", stuck: false };
const stuck: RenderField = { phase: "active", severity: "heavy", stuck: true };
const clearing: RenderField = { phase: "clearing", severity: "heavy", stuck: false };

describe("buildRockField", () => {
  it("is the same field every time, the near layer sparser and faster than the far", () => {
    const field = buildRockField();
    expect(buildRockField()).toEqual(field);
    expect(field.near.rocks.length).toBeLessThan(field.far.rocks.length);
    expect(field.near.parallax).toBeGreaterThan(field.far.parallax);
    for (const rock of [...field.far.rocks, ...field.near.rocks]) {
      expect(rock.x).toBeGreaterThanOrEqual(0);
      expect(rock.x).toBeLessThan(1);
      expect(rock.radius).toBeGreaterThan(0);
      expect(rock.outline.every((corner) => corner > 0 && corner <= 1)).toBe(true);
    }
  });

  it("shows more rocks the worse the field", () => {
    const { far } = buildRockField();
    expect(rocksShown(far, "light")).toBeLessThan(rocksShown(far, "heavy"));
    expect(rocksShown(far, "heavy")).toBeLessThan(rocksShown(far, "brutal"));
    expect(rocksShown(far, "brutal")).toBe(far.rocks.length);
  });
});

describe("RockFade", () => {
  it("fades in over the warning while the field is near, and holds full while active", () => {
    const fade = new RockFade();
    fade.advance(FADE_IN_NEAR_MS / 2, near);
    expect(fade.alpha).toBeCloseTo(0.5);
    fade.advance(FADE_IN_NEAR_MS, near);
    expect(fade.alpha).toBe(1);
    fade.advance(10_000, active);
    expect(fade.alpha).toBe(1);
  });

  it("comes in at once for a field nobody saw coming (it arrives active)", () => {
    const fade = new RockFade();
    fade.advance(FADE_IN_ACTIVE_MS, active);
    expect(fade.alpha).toBe(1);
  });

  it("fades out while clearing and after the field is gone, keeping its severity", () => {
    const fade = new RockFade();
    fade.advance(FADE_IN_ACTIVE_MS, { ...active, severity: "brutal" });
    fade.advance(FADE_OUT_MS / 4, { ...clearing, severity: "brutal" });
    expect(fade.alpha).toBeCloseTo(0.75);
    fade.advance(FADE_OUT_MS, undefined);
    expect(fade.alpha).toBe(0);
    expect(fade.severity).toBe("brutal");
  });

  it("holds while paused (no time passes)", () => {
    const fade = new RockFade();
    fade.advance(1_000, near);
    const before = fade.alpha;
    fade.advance(0, near);
    expect(fade.alpha).toBe(before);
  });

  it("aims for the rocks only while the field is near or around the ship", () => {
    expect(fadeTarget(near)).toBe(1);
    expect(fadeTarget(active)).toBe(1);
    expect(fadeTarget(clearing)).toBe(0);
    expect(fadeTarget(undefined)).toBe(0);
  });
});

describe("rockScrollSpeed", () => {
  it("streams with the stars, and stands still when stuck or paused", () => {
    expect(rockScrollSpeed(active, 1, false)).toBe(1);
    expect(rockScrollSpeed(stuck, 0.03, false)).toBe(0);
    expect(rockScrollSpeed(active, 1, true)).toBe(0);
  });
});

describe("drawRockLayer", () => {
  const field = buildRockField();
  // Larger than one repeat of the layer each way, so every rock shown is drawn at least once.
  const area = { x: 0, y: 0, width: 1300, height: 1300 };
  const paint = (alpha: number): RockPaint => ({ field, scrollPx: 1234, alpha, severity: "heavy" });

  it("draws the layer's rocks as filled outlines across the area", () => {
    const canvas = mockCanvas();
    drawRockLayer(canvas.ctx, field.far, area, 24, paint(1));
    expect(canvas.calls.get("fill") ?? 0).toBeGreaterThanOrEqual(rocksShown(field.far, "heavy"));
    expect(canvas.calls.get("closePath")).toBe(canvas.calls.get("fill"));
  });

  it("draws nothing once faded out", () => {
    const canvas = mockCanvas();
    drawRockLayer(canvas.ctx, field.near, area, 24, paint(0));
    expect(canvas.calls.get("fill") ?? 0).toBe(0);
  });
});
