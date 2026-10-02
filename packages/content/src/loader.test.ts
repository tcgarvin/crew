import { describe, expect, it } from "vitest";
import { loadBundle, rawBundle } from "./loader";

describe("loadBundle", () => {
  it("loads and validates the authored content bundle clean (L1-L3)", () => {
    const result = loadBundle();
    if (!result.ok) {
      // Pretty-print issues so a failure here is diagnosable at a glance.
      const details = result.issues.map((i) => `[${i.level}] ${i.path.join(".")}: ${i.message}`);
      throw new Error(`content bundle failed validation:\n${details.join("\n")}`);
    }
    expect(result.ok).toBe(true);
  });

  it("computes a stable hash across repeated loads", () => {
    expect(rawBundle().hash).toBe(rawBundle().hash);
  });

  it("gives every crew member a voice of their own (D38)", () => {
    const result = loadBundle();
    if (!result.ok) throw new Error("content bundle failed validation");
    const voices = Object.values(result.bundle.crew).map((c) => c.voice);
    expect(voices).toHaveLength(8);
    for (const voice of voices) expect(voice.trim().split(/\s+/).length).toBeLessThan(60);
    expect(new Set(voices).size).toBe(8);
  });

  it("gives every port a market, well stocked at the Hub and bare at Green Meridian (D47)", () => {
    const result = loadBundle();
    if (!result.ok) throw new Error("content bundle failed validation");
    const parts = (portId: string) =>
      result.bundle.ports[portId as keyof typeof result.bundle.ports]?.market.find(
        (line) => line.itemDefId === "item.spare_parts_stack",
      );
    expect(parts("port.crossroads_hub")).toMatchObject({ count: 4 });
    expect(parts("port.kessler_drift")).toMatchObject({ count: 1 });
    expect(parts("port.green_meridian")).toMatchObject({ count: 0 });
    for (const port of Object.values(result.bundle.ports)) {
      for (const line of port.market) {
        expect(result.bundle.items[line.itemDefId]).toBeDefined();
        expect(line.price).toBeGreaterThan(0);
      }
    }
    expect(result.bundle.config.commerce.market.maxStockPerCommand).toBe(4);
  });

  it("has all 8 crew, 10 traits and the default scenario", () => {
    const bundle = rawBundle() as {
      crew: Record<string, unknown>;
      traits: Record<string, unknown>;
      scenarios: Record<string, unknown>;
    };
    expect(Object.keys(bundle.crew)).toHaveLength(8);
    expect(Object.keys(bundle.traits)).toHaveLength(10);
    expect(Object.keys(bundle.scenarios)).toHaveLength(1);
  });
});

describe("port distances (D10: short hop <= ~30s)", () => {
  const bundle = rawBundle() as {
    ports: Record<
      string,
      { id: string; routes: readonly { toPortId: string; distance: number }[] }
    >;
  };

  function distance(from: string, to: string): number | undefined {
    return bundle.ports[from]?.routes.find((r) => r.toPortId === to)?.distance;
  }

  it("hub <-> mining is a short hop (~25s)", () => {
    expect(distance("port.crossroads_hub", "port.kessler_drift")).toBe(25);
    expect(distance("port.kessler_drift", "port.crossroads_hub")).toBe(25);
  });

  it("hub <-> agri is a medium hop (~45s)", () => {
    expect(distance("port.crossroads_hub", "port.green_meridian")).toBe(45);
    expect(distance("port.green_meridian", "port.crossroads_hub")).toBe(45);
  });

  it("mining <-> agri is the long hop (~70s)", () => {
    expect(distance("port.kessler_drift", "port.green_meridian")).toBe(70);
    expect(distance("port.green_meridian", "port.kessler_drift")).toBe(70);
  });
});
