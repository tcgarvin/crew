import type { DeckDefId, MachineDefId, RenderMachine, RenderMachineState } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { LayoutMachine } from "./deckLayout";
import { engineOutput, hullGeometry } from "./hull";

const DECK = "deck.test" as DeckDefId;

const layout = { width: 32, height: 18 };

function machine(key: string, tags: LayoutMachine["tags"]): LayoutMachine {
  return {
    placementKey: key,
    defId: "machine.test" as MachineDefId,
    name: key,
    tags,
    footprint: [{ x: 25, y: 2 }],
    center: { x: 25.5, y: 2.5 },
  };
}

function rendered(key: string, state: RenderMachineState): RenderMachine {
  return { id: key as never, state, temperatureNorm: 0, deckId: DECK, placementKey: key };
}

describe("hullGeometry", () => {
  it("puts the nose fore of the deck (+x) and engine bells aft (-x), never over the deck", () => {
    const hull = hullGeometry(layout);
    expect(hull.bounds.maxX).toBeGreaterThan(layout.width + 1);
    expect(hull.bounds.minX).toBeLessThan(-1);
    // The nose's tip is the hull's bow-most point.
    expect(Math.max(...hull.outline.map((p) => p.x))).toBe(hull.bounds.maxX);
    expect(hull.bells.length).toBeGreaterThan(0);
    for (const bell of hull.bells) {
      expect(bell.throatX).toBeLessThanOrEqual(0);
      expect(bell.mouthX).toBeLessThan(bell.throatX);
      expect(bell.mouthX).toBe(hull.bounds.minX);
      expect(bell.mouthHalf).toBeGreaterThan(bell.throatHalf);
      expect(bell.y).toBeGreaterThan(0);
      expect(bell.y).toBeLessThan(layout.height);
    }
    // Every outline point sits on or outside the deck rectangle.
    for (const p of hull.outline) {
      const inside = p.x > 0 && p.x < layout.width && p.y > 0 && p.y < layout.height;
      expect(inside).toBe(false);
    }
  });

  it("puts the bridge windows inside the nose, beyond the deck's bow wall", () => {
    const hull = hullGeometry(layout);
    expect(hull.windows.length).toBeGreaterThan(1);
    for (const p of hull.windows) {
      expect(p.x).toBeGreaterThan(layout.width);
      expect(p.x).toBeLessThan(hull.bounds.maxX);
    }
  });

  it("reads nothing but the deck's size: the same rectangle gives the same hull", () => {
    const tagged = {
      ...layout,
      compartmentTags: { bridge: ["bridge"] },
      compartmentBoxes: { bridge: { minX: 0, minY: 0, maxX: 4, maxY: 8 } },
    };
    expect(hullGeometry(tagged)).toEqual(hullGeometry(layout));
  });
});

describe("engineOutput", () => {
  const deck = {
    deckId: DECK,
    machines: [machine("engine_1", ["engine"]), machine("pump_1", [])],
  };

  it("is full for a healthy engine and weaker for a derated one", () => {
    const pump = rendered("pump_1", "failed");
    expect(engineOutput({ machines: [rendered("engine_1", "ok"), pump] }, deck)).toBe(1);
    const derated = engineOutput({ machines: [rendered("engine_1", "degraded"), pump] }, deck);
    expect(derated).toBeGreaterThan(0);
    expect(derated).toBeLessThan(1);
    expect(engineOutput({ machines: [rendered("engine_1", "failed")] }, deck)).toBe(0);
    expect(engineOutput({ machines: [rendered("engine_1", "off")] }, deck)).toBe(0);
  });

  it("does not constrain a deck with no engines", () => {
    expect(engineOutput({ machines: [] }, { deckId: DECK, machines: [] })).toBe(1);
  });
});
