import {
  DOCK_FOREGROUND_KINDS,
  DOCK_POST_KINDS,
  DOCK_PROP_KINDS,
  type DockDef,
  type DockPropDef,
  type LocalKey,
  type PortDefId,
  type RenderFrame,
  type RenderTravel,
  type TravelStage,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { cameraBounds } from "./camera";
import { buildDeckLayout } from "./deckLayout";
import { clampEngagement, dockInView } from "./dock";
import { drawDock, drawDockForeground } from "./dockArt";
import { PROP_DRAWERS, drawProp } from "./dockProps";
import { dockShape } from "./dockShape";
import { computeFitTransform, drawFrame, shouldRotate } from "./draw";
import { hullGeometry } from "./hull";
import { sceneAt, withDockSky } from "./scene";
import { buildStarField } from "./stars";
import { mockCanvas } from "./testCanvas";

const { bundle, scenarioId } = loadWebContent();
const scenario = bundle.scenarios[scenarioId];
if (scenario === undefined) throw new Error("no scenario");
const deck = bundle.decks[scenario.deckId];
if (deck === undefined) throw new Error("no deck");
const layout = buildDeckLayout(deck, bundle);
const hull = hullGeometry(layout);
const stars = buildStarField();
const docks = bundle.docks ?? {};
const allDocks: DockDef[] = Object.values(docks);

function travel(state: TravelStage, progress: number, from: string, to: string): RenderTravel {
  return {
    state,
    progress,
    fromPortId: from as PortDefId,
    toPortId: to as PortDefId,
    drifting: false,
  };
}

/** A frame with somebody at every post, a crate in each area and the ramps down. */
function frameAt(dock: DockDef, t: RenderTravel): RenderFrame {
  const at = (x: number, y: number) => ({ x: x - dock.shipAt.x + 0.5, y: y - dock.shipAt.y + 0.5 });
  return {
    tick: 0 as RenderFrame["tick"],
    actors: dock.posts.map((post, i) => ({
      id: `local${i}` as RenderFrame["actors"][number]["id"],
      name: post.name,
      deckId: layout.deckId,
      ...at(post.tile.x, post.tile.y),
      actionLabel: "waiting",
      passenger: false,
    })),
    machines: [],
    doors: layout.doors.map((d) => ({
      id: d.placementKey as unknown as RenderFrame["doors"][number]["id"],
      physicalState: "open" as const,
      openFraction: 1,
      deckId: layout.deckId,
      placementKey: d.placementKey,
    })),
    travel: t,
    tickerEvents: [],
    money: 0,
    items: dock.areas.map((area, i) => ({
      id: `crate${i}` as RenderFrame["items"][number]["id"],
      defId: "item.crate" as RenderFrame["items"][number]["defId"],
      name: "crate",
      kind: "crate" as const,
      cargoClass: "general" as const,
      location: { kind: "deck" as const, deckId: layout.deckId, ...at(area.rect.x, area.rect.y) },
      count: 2,
    })),
    headline: "",
  };
}

function render(
  dock: DockDef,
  t: RenderTravel,
  width: number,
  height: number,
  reducedMotion = false,
) {
  const { ctx, calls } = mockCanvas();
  const shown = dockInView({ travel: t }, docks);
  const scene = withDockSky(sceneAt(t, bundle.ports, { reducedMotion }), shown);
  const rotated = shouldRotate(width, height, layout);
  const transform = computeFitTransform(
    width,
    height,
    cameraBounds(hull, shown, scene.cameraT),
    rotated,
  );
  drawFrame(
    ctx,
    transform,
    layout,
    frameAt(dock, t),
    width,
    height,
    rotated,
    {
      scene,
      hull,
      stars,
      starScrollPx: 40,
      plume: scene.plume,
      flicker: 0,
      dock: shown,
      clamps: clampEngagement(t),
    },
    dock.posts[0] === undefined ? undefined : { kind: "post", id: dock.posts[0].key },
  );
  return calls;
}

describe("every authored dock draws", () => {
  it("has one map per port, six in all", () => {
    expect(allDocks.length).toBe(6);
  });

  for (const dock of allDocks) {
    const other = allDocks.find((d) => d !== dock)?.portId ?? dock.portId;
    const moments: RenderTravel[] = [
      travel("approaching", 0.9, other, dock.portId),
      travel("docking", 0.4, other, dock.portId),
      travel("docked", 0, dock.portId, dock.portId),
      travel("undocking", 0.6, dock.portId, other),
      travel("departing", 0.3, dock.portId, other),
    ];
    for (const [width, height] of [
      [940, 720],
      [390, 700],
    ] as const) {
      it(`${dock.id} at ${width}×${height}, arriving, berthed and leaving`, () => {
        for (const t of moments) {
          const calls = render(dock, t, width, height);
          expect(calls.get("fillRect") ?? 0, `${t.state}`).toBeGreaterThan(50);
        }
        // Reduced motion cross-fades instead of sliding; the same code paths must hold.
        expect(() => render(dock, moments[1] as RenderTravel, width, height, true)).not.toThrow();
      });
    }
  }
});

describe("dock layers on their own", () => {
  for (const dock of allDocks) {
    it(`${dock.id}: map and foreground draw, and skip entirely when faded out`, () => {
      const paint = {
        origin: { x: -dock.shipAt.x, y: -dock.shipAt.y },
        alpha: 1,
        clamps: 1,
        px: 0.05,
        view: { minX: -10, minY: -10, maxX: 60, maxY: 40 },
        enclosure: 1,
      };
      const drawn = mockCanvas();
      drawDock(drawn.ctx, dock, paint);
      drawDockForeground(drawn.ctx, dock, paint, hull.bounds, paint.view);
      expect(drawn.calls.get("fillRect") ?? 0).toBeGreaterThan(20);
      const faded = mockCanvas();
      drawDock(faded.ctx, dock, { ...paint, alpha: 0 });
      drawDockForeground(faded.ctx, dock, { ...paint, alpha: 0 }, hull.bounds, paint.view);
      expect(faded.calls.size).toBe(0);
    });
  }

  it("has a drawing for every prop kind in the closed vocabulary", () => {
    expect(Object.keys(PROP_DRAWERS).sort()).toEqual([...DOCK_PROP_KINDS].sort());
  });

  it("draws every prop kind at every rotation, blocking or not", () => {
    const hub = allDocks[0];
    if (hub === undefined) throw new Error("no docks");
    for (const kind of DOCK_PROP_KINDS) {
      for (const rot of [0, 90, 180, 270] as const) {
        for (const rect of [
          { x: 2, y: 3, w: 1, h: 1 },
          { x: 2, y: 3, w: 4, h: 2 },
          { x: 2, y: 3, w: 2, h: 5 },
        ]) {
          const prop: DockPropDef = {
            key: `${kind}_${rot}` as LocalKey,
            kind,
            rect,
            rot,
            blocking: rot !== 90,
          };
          const { ctx, calls } = mockCanvas();
          drawProp(ctx, prop, { palette: hub.palette, setting: hub.setting, px: 0.05 });
          expect(calls.size, `${kind} ${rot}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("draws every post and foreground kind, used or not", () => {
    const base = allDocks[0];
    if (base === undefined) throw new Error("no docks");
    const post = base.posts[0];
    if (post === undefined) throw new Error("no post");
    const dock: DockDef = {
      ...base,
      posts: DOCK_POST_KINDS.map((kind, i) => ({
        ...post,
        key: `post_${kind}` as LocalKey,
        kind,
        facing: (["n", "e", "s", "w"] as const)[i % 4] ?? "n",
      })),
      foreground: DOCK_FOREGROUND_KINDS.map((kind, i) => ({
        kind,
        rect: { x: i * 3, y: 0, w: i % 2 === 0 ? 3 : 1, h: i % 2 === 0 ? 1 : 6 },
      })),
    };
    const paint = {
      origin: { x: -dock.shipAt.x, y: -dock.shipAt.y },
      alpha: 1,
      clamps: 0.5,
      px: 0.05,
      view: { minX: -10, minY: -10, maxX: 60, maxY: 40 },
      enclosure: 0.5,
    };
    const { ctx } = mockCanvas();
    expect(() => {
      drawDock(ctx, dock, paint);
      drawDockForeground(ctx, dock, paint, hull.bounds, paint.view);
    }).not.toThrow();
  });
});

describe("dockShape", () => {
  it("finds the berth as the ship's footprint in every map", () => {
    for (const dock of allDocks) {
      const { berth } = dockShape(dock);
      expect(berth, dock.id).toEqual({
        minX: dock.shipAt.x,
        minY: dock.shipAt.y,
        maxX: dock.shipAt.x + layout.width,
        maxY: dock.shipAt.y + layout.height,
      });
    }
  });

  it("reads each place's character off its map", () => {
    const byPort = (port: string) => {
      const dock = allDocks.find((d) => d.portId === port);
      if (dock === undefined) throw new Error(port);
      return dockShape(dock);
    };
    // A farming world's pad set into the field; a pier out into open sky.
    expect(byPort("port.green_meridian")).toMatchObject({
      berthStyle: "pad",
      floorPattern: "slabs",
      overSky: false,
    });
    expect(byPort("port.terns_rest")).toMatchObject({
      berthStyle: "open",
      floorPattern: "planks",
      overSky: true,
    });
    for (const port of ["port.crossroads_hub", "port.kessler_drift", "port.ossory_station"]) {
      expect(byPort(port)).toMatchObject({ floorPattern: "plates", overSky: false });
    }
    // Every map has a quay edge the ramps come down onto.
    for (const dock of allDocks) expect(dockShape(dock).quay.length, dock.id).toBeGreaterThan(0);
  });
});
