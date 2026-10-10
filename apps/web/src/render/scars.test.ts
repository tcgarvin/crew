/**
 * §hull-scars-and-ship-loss (calls 16, 25): hull scars drawn per tile, patched ones dimmer; and
 * found by tile for a tap.
 */
import type { RenderScar, ScarId } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { drawScars, scarAt } from "./scars";
import { mockCanvas } from "./testCanvas";

function scar(id: string, x: number, y: number, patched: boolean, rock: RenderScar["rock"]) {
  return { id: id as ScarId, x, y, patched, rock };
}

describe("drawScars", () => {
  it("draws an unpatched scar as a hole with cracks, more for a large rock", () => {
    const small = mockCanvas();
    drawScars(small.ctx, [scar("r1", 3, 4, false, "small")], 1 / 24);
    expect(small.calls.get("arc")).toBe(1);
    const large = mockCanvas();
    drawScars(large.ctx, [scar("r1", 3, 4, false, "large")], 1 / 24);
    expect(large.calls.get("lineTo") ?? 0).toBeGreaterThan(small.calls.get("lineTo") ?? 0);
  });

  it("draws a patched scar as a plate, with no hole", () => {
    const canvas = mockCanvas();
    drawScars(canvas.ctx, [scar("r1", 3, 4, true, "large")], 1 / 24);
    expect(canvas.calls.get("arc") ?? 0).toBe(0);
    expect(canvas.calls.get("fillRect")).toBe(1);
  });

  it("outlines the selected scar", () => {
    const canvas = mockCanvas();
    drawScars(canvas.ctx, [scar("r1", 3, 4, true, "small")], 1 / 24, "r1");
    expect(canvas.calls.get("strokeRect")).toBe(2);
  });
});

describe("scarAt", () => {
  const scars = [scar("r1", 3, 4, true, "small"), scar("r2", 3, 4, false, "large")];

  it("finds the newest scar on the tapped tile", () => {
    expect(scarAt(scars, 3.9, 4.1)?.id).toBe("r2");
  });

  it("finds none on a clean tile", () => {
    expect(scarAt(scars, 4.1, 4.1)).toBeUndefined();
  });
});
