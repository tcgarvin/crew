/**
 * §rock-impacts, §hull-scars-and-ship-loss: a whole frame in an asteroid field draws: both rock
 * layers, a flash and the scars, on the real deck in transit, landscape and portrait.
 */
import type { PortDefId, RenderFrame, RenderScar, ScarId, Tick } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { buildDeckLayout } from "./deckLayout";
import { computeFitTransform, drawFrame, shouldRotate } from "./draw";
import { hullGeometry } from "./hull";
import { buildRockField } from "./rocks";
import { sceneAt } from "./scene";
import { buildStarField } from "./stars";
import { mockCanvas } from "./testCanvas";

const { bundle, scenarioId } = loadWebContent();
const scenario = bundle.scenarios[scenarioId];
const deck = scenario === undefined ? undefined : bundle.decks[scenario.deckId];
if (deck === undefined) throw new Error("no deck");
const layout = buildDeckLayout(deck, bundle);
const hull = hullGeometry(layout);
const portIds = Object.keys(bundle.ports) as PortDefId[];
const [from, to] = portIds;
if (from === undefined || to === undefined) throw new Error("two ports");

const floor = layout.tiles.find((t) => t.compartmentKey !== undefined);
if (floor === undefined) throw new Error("the deck has floor");
const hit = { x: floor.x, y: floor.y };
const scars: RenderScar[] = [
  { id: "r1" as ScarId, x: floor.x, y: floor.y, patched: false, rock: "large" },
  { id: "r2" as ScarId, x: floor.x + 1, y: floor.y, patched: true, rock: "small" },
];

const frame: RenderFrame = {
  tick: 2_000 as Tick,
  actors: [],
  machines: [],
  doors: [],
  travel: { state: "transit", progress: 0.4, fromPortId: from, toPortId: to, drifting: false },
  tickerEvents: [],
  money: 0,
  items: [],
  headline: "",
  locals: [],
  dockProps: [],
  sessions: [],
  hull: { integrity: 81, max: 100, scars, lost: false },
  alert: true,
  field: { phase: "active", severity: "brutal", stuck: false },
  impacts: [],
  shots: [],
};

function render(width: number, height: number, withField: boolean) {
  const canvas = mockCanvas();
  const scene = sceneAt(frame.travel, bundle.ports, { reducedMotion: false });
  const rotated = shouldRotate(width, height, layout);
  const transform = computeFitTransform(width, height, hull.bounds, rotated);
  drawFrame(canvas.ctx, transform, layout, frame, width, height, rotated, {
    scene,
    hull,
    stars: buildStarField(),
    starScrollPx: 300,
    plume: 1,
    flicker: 0,
    dock: undefined,
    clamps: 0,
    ...(withField
      ? {
          rocks: { field: buildRockField(), scrollPx: 300, alpha: 1, severity: "brutal" as const },
          flashes: [
            {
              impact: {
                tick: 2_000 as Tick,
                ...hit,
                rock: "large" as const,
                tiles: [hit],
              },
              t: 0.2,
            },
          ],
        }
      : {}),
  });
  return canvas.calls;
}

describe("drawFrame in an asteroid field", () => {
  for (const [width, height] of [
    [390, 560],
    [1280, 700],
  ] as const) {
    it(`draws rocks, a flash and scars at ${width}×${height}`, () => {
      const plain = render(width, height, false);
      const field = render(width, height, true);
      // The rocks are closed outlines; nothing else in a transit frame closes as many paths.
      expect(field.get("closePath") ?? 0).toBeGreaterThan((plain.get("closePath") ?? 0) + 10);
      // Scars draw with or without a field.
      expect(plain.get("strokeRect") ?? 0).toBeGreaterThan(0);
    });
  }
});
