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
    expect(voices).toHaveLength(9);
    for (const voice of voices) expect(voice.trim().split(/\s+/).length).toBeLessThan(60);
    expect(new Set(voices).size).toBe(9);
  });

  it("ships a generic passenger template with no skills, role tags or inventory", () => {
    const result = loadBundle();
    if (!result.ok) throw new Error("content bundle failed validation");
    const passenger = result.bundle.crew["crew.passenger" as keyof typeof result.bundle.crew];
    expect(passenger).toBeDefined();
    expect(passenger?.skills).toEqual({});
    expect(passenger?.roleTags).toEqual([]);
    expect(passenger?.startingInventory).toEqual([]);
    expect(passenger?.traits ?? []).toEqual([]);
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

  it("has 8 crew plus the passenger template, 10 traits and the default scenario", () => {
    const bundle = rawBundle() as {
      crew: Record<string, unknown>;
      traits: Record<string, unknown>;
      scenarios: Record<string, unknown>;
    };
    expect(Object.keys(bundle.crew)).toHaveLength(9);
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

describe("the six-port galaxy (passengers spec §2.1, §2.4)", () => {
  const result = loadBundle();
  if (!result.ok) throw new Error("content bundle failed validation");
  const ports = result.bundle.ports;
  const ids = Object.keys(ports).sort();

  it("has the three core ports and three far ports", () => {
    expect(ids).toEqual([
      "port.crossroads_hub",
      "port.green_meridian",
      "port.kessler_drift",
      "port.ossory_station",
      "port.terns_rest",
      "port.vesper_gate",
    ]);
  });

  it("puts every far port on a single long spur off one core port", () => {
    const spur = (id: string) => ports[id as keyof typeof ports]?.routes;
    expect(spur("port.ossory_station")).toEqual([
      { toPortId: "port.kessler_drift", distance: 120 },
    ]);
    expect(spur("port.vesper_gate")).toEqual([{ toPortId: "port.green_meridian", distance: 120 }]);
    expect(spur("port.terns_rest")).toEqual([{ toPortId: "port.crossroads_hub", distance: 90 }]);
  });

  it("lists every route in both directions with the same distance", () => {
    for (const port of Object.values(ports)) {
      for (const route of port.routes) {
        const back = ports[route.toPortId]?.routes.find((r) => r.toPortId === port.id);
        expect(back, `${port.id} -> ${route.toPortId}`).toBeDefined();
        expect(back?.distance).toBe(route.distance);
      }
    }
  });

  it("gives every port character, two or three cast seeds and a lounge for passengers ashore", () => {
    for (const port of Object.values(ports)) {
      expect(port.character.trim().length, port.id).toBeGreaterThan(0);
      expect(port.castSeed.length, port.id).toBeGreaterThanOrEqual(2);
      expect(port.castSeed.length, port.id).toBeLessThanOrEqual(3);
      expect(
        port.externalStores.some((s) => s.kind === "lounge"),
        port.id,
      ).toBe(true);
    }
  });

  it("gives every port one dock map, with at least one regular posted on it (Dockside §3.3)", () => {
    const docks = Object.values(result.bundle.docks ?? {});
    for (const port of Object.values(ports)) {
      expect(docks.filter((d) => d.portId === port.id).length, port.id).toBe(1);
      expect(
        port.castSeed.some((seed) => seed.post !== undefined),
        port.id,
      ).toBe(true);
    }
    const planets = docks.filter((d) => d.setting === "planet").map((d) => d.portId);
    expect(planets.sort()).toEqual(["port.green_meridian", "port.terns_rest"]);
  });

  it("stocks each port differently (D47)", () => {
    const stock = Object.values(ports).map((p) =>
      p.market.map((l) => `${l.itemDefId}:${l.count}:${l.price}`).join(","),
    );
    expect(new Set(stock).size).toBe(stock.length);
  });
});
