import type { BerthedDock, PortDefId, RenderTravel, TravelStage } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { portraitCanvasSize } from "../ui/portraitLayout";
import { loadWebContent } from "../worker/content";
import { DOCKED_MARGIN_TILES, cameraBounds, dockedBounds, flightBounds } from "./camera";
import { buildDeckLayout } from "./deckLayout";
import { berthInView, dockInView, dockRectOnDeck } from "./dock";
import { computeFitTransform, shouldRotate } from "./draw";
import type { Bounds } from "./hull";
import { hullGeometry } from "./hull";
import { sceneAt } from "./scene";

const { bundle, scenarioId } = loadWebContent();
const scenario = bundle.scenarios[scenarioId];
if (scenario === undefined) throw new Error("no scenario");
const deck = bundle.decks[scenario.deckId];
if (deck === undefined) throw new Error("no deck");
const layout = buildDeckLayout(deck, bundle);
const hull = hullGeometry(layout);
const docks = bundle.docks ?? {};
/** Every authored dock with the scenario deck in its berth box (§ship-placement). */
const allDocks: BerthedDock[] = Object.values(docks).map((dock) => berthInView(dock, layout));
const MOTION = { reducedMotion: false };

function travel(state: TravelStage, progress: number, from: string, to: string): RenderTravel {
  return {
    state,
    progress,
    fromPortId: from as PortDefId,
    toPortId: to as PortDefId,
    drifting: false,
  };
}

/** What the canvas frames for this travel moment, as `DeckCanvas` computes it. */
function framed(t: RenderTravel): Bounds {
  const dock = dockInView({ travel: t }, docks);
  const berth = dock === undefined ? undefined : berthInView(dock, layout);
  return cameraBounds(hull, berth, sceneAt(t, bundle.ports, MOTION).cameraT);
}

function expectClose(a: Bounds, b: Bounds, eps = 1e-9): void {
  expect(Math.abs(a.minX - b.minX)).toBeLessThan(eps);
  expect(Math.abs(a.minY - b.minY)).toBeLessThan(eps);
  expect(Math.abs(a.maxX - b.maxX)).toBeLessThan(eps);
  expect(Math.abs(a.maxY - b.maxY)).toBeLessThan(eps);
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

describe("camera framing at both ends", () => {
  it("frames the hull with a margin in flight, whatever dock is in view", () => {
    for (const dock of allDocks) {
      expect(cameraBounds(hull, dock, 0)).toEqual(flightBounds(hull));
    }
    const port = allDocks[0]?.dock.portId ?? "";
    expectClose(framed(travel("transit", 0.5, "x", port)), flightBounds(hull));
  });

  it("fits ship plus the whole dock map when docked, for every authored dock", () => {
    expect(allDocks.length).toBe(6);
    for (const dock of allDocks) {
      const { portId, id } = dock.dock;
      const docked = framed(travel("docked", 0, portId, portId));
      expect(docked).toEqual(dockedBounds(hull, dock));
      expect(contains(docked, hull.bounds), id).toBe(true);
      expect(contains(docked, dockRectOnDeck(dock)), id).toBe(true);
      // Tight: nothing beyond the map and hull but the margin.
      const map = dockRectOnDeck(dock);
      expect(docked.minY).toBeCloseTo(Math.min(map.minY, hull.bounds.minY) - DOCKED_MARGIN_TILES);
      expect(docked.maxY).toBeCloseTo(Math.max(map.maxY, hull.bounds.maxY) + DOCKED_MARGIN_TILES);
    }
  });

  it("keeps the flight framing when the port has no dock map (the stand-in berth)", () => {
    expect(dockedBounds(hull, undefined)).toEqual(flightBounds(hull));
  });
});

describe("legibility on a 390×700 portrait phone", () => {
  // The canvas the app lays out under its portrait chrome (top bar, headline, travel bar, compact
  // log), not the whole window. Dots are at least 8 px across and labels 11 px whatever the scale;
  // at 12 px a tile the compartment labels show and the ship reads.
  const [width, height] = [390, 700];
  const rotated = shouldRotate(width, height, layout);

  it("turns the deck and leaves the canvas most of the height", () => {
    expect(rotated).toBe(true);
    const docked = portraitCanvasSize(width, height, { travelBar: false, logExpanded: false });
    expect(docked.width).toBe(390);
    expect(docked.height).toBeGreaterThan(560);
  });

  it("frames ship and dock map at more than 12 px a tile at every dock", () => {
    const canvas = portraitCanvasSize(width, height, { travelBar: false, logExpanded: false });
    for (const dock of allDocks) {
      const t = computeFitTransform(canvas.width, canvas.height, dockedBounds(hull, dock), rotated);
      expect(t.scale, dock.dock.id).toBeGreaterThan(12);
    }
  });

  it("frames the ship in flight at more than 12 px a tile", () => {
    const canvas = portraitCanvasSize(width, height, { travelBar: true, logExpanded: false });
    const t = computeFitTransform(canvas.width, canvas.height, flightBounds(hull), rotated);
    expect(t.scale).toBeGreaterThan(12);
  });

  it("still shows the whole ship, smaller, with the log opened out", () => {
    const canvas = portraitCanvasSize(width, height, { travelBar: true, logExpanded: true });
    const t = computeFitTransform(canvas.width, canvas.height, flightBounds(hull), rotated);
    expect(t.scale).toBeGreaterThan(9);
    expect(t.scale).toBeLessThan(12);
  });
});

describe("camera continuity", () => {
  const ports = allDocks.map((d) => d.dock.portId);

  for (const port of ports) {
    const other = ports.find((p) => p !== port) ?? port;
    it(`does not jump at the stage seams arriving at and leaving ${port}`, () => {
      expectClose(
        framed(travel("approaching", 1, other, port)),
        framed(travel("docking", 0, other, port)),
      );
      expectClose(
        framed(travel("docking", 1, other, port)),
        framed(travel("docked", 0, port, port)),
      );
      expectClose(
        framed(travel("preparingDeparture", 1, port, other)),
        framed(travel("undocking", 0, port, other)),
      );
      expectClose(
        framed(travel("undocking", 1, port, other)),
        framed(travel("departing", 0, port, other)),
      );
    });

    it(`eases smoothly through docking and undocking at ${port}`, () => {
      for (const stage of ["docking", "undocking"] as const) {
        const from = stage === "docking" ? other : port;
        const to = stage === "docking" ? port : other;
        let prev = framed(travel(stage, 0, from, to));
        for (let i = 1; i <= 100; i++) {
          const next = framed(travel(stage, i / 100, from, to));
          for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
            // Each edge moves at most a little per 1% of the stage.
            expect(Math.abs(next[key] - prev[key]), `${stage} ${key} at ${i}%`).toBeLessThan(0.5);
          }
          prev = next;
        }
      }
    });
  }
});
