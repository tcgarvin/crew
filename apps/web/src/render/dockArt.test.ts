import {
  DOCK_FOREGROUND_KINDS,
  DOCK_POST_KINDS,
  DOCK_PROP_KINDS,
  type DockDef,
  type DockPropDef,
  HULL_SIZE_BOX,
  type LocalKey,
  type PortDefId,
  type PortSetting,
  type RenderFrame,
  type RenderTravel,
  type TravelStage,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { cameraBounds } from "./camera";
import { buildDeckLayout } from "./deckLayout";
import { berthInView, clampEngagement, dockInView } from "./dock";
import { drawDock, drawDockForeground } from "./dockArt";
import { PROP_DRAWERS, drawProp } from "./dockProps";
import { dockShape, dockSurface } from "./dockShape";
import { CREW_DOT_COLOR, computeFitTransform, drawFrame, shouldRotate } from "./draw";
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

const ALONGSIDE: ReadonlySet<TravelStage> = new Set([
  "docking",
  "docked",
  "preparingDeparture",
  "undocking",
]);

function settingOf(dock: DockDef): PortSetting {
  const port = bundle.ports[dock.portId];
  if (port === undefined) throw new Error(`no port ${dock.portId}`);
  return port.setting;
}

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
  const { shipAt } = berthInView(dock, layout);
  const at = (x: number, y: number) => ({ x: x - shipAt.x + 0.5, y: y - shipAt.y + 0.5 });
  return {
    tick: 0 as RenderFrame["tick"],
    actors: dock.posts.map((post, i) => ({
      id: `local${i}` as RenderFrame["actors"][number]["id"],
      name: post.name,
      deckId: layout.deckId,
      ...at(post.tile.x, post.tile.y),
      actionLabel: "waiting",
      passenger: false,
      onDock: true,
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
      location: {
        kind: "deck" as const,
        deckId: layout.deckId,
        ...at(area.rect.x, area.rect.y),
        onDock: true,
      },
      count: 2,
    })),
    headline: "",
    locals: [],
    dockProps: [],
    // D61: the sim names the dock alongside from the start of docking to the end of undocking.
    ...(ALONGSIDE.has(t.state) ? { dock: { dockId: dock.id, deckId: layout.deckId } } : {}),
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
    cameraBounds(hull, shown === undefined ? undefined : berthInView(shown, layout), scene.cameraT),
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
      const { shipAt } = berthInView(dock, layout);
      const paint = {
        origin: { x: -shipAt.x, y: -shipAt.y },
        alpha: 1,
        clamps: 1,
        px: 0.05,
        view: { minX: -10, minY: -10, maxX: 60, maxY: 40 },
        enclosure: 1,
        setting: settingOf(dock),
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
          drawProp(ctx, prop, { palette: hub.palette, setting: settingOf(hub), px: 0.05 });
          expect(calls.size, `${kind} ${rot}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("draws the ore conveyor with nothing that reads as a person's dot (D69)", () => {
    // Round gold lumps on Kessler's belt read as crew dots at phone scale: the ore is drawn as
    // angular chunks (no arcs), in colours well away from crew gold.
    const kessler = allDocks.find((d) => d.props.some((p) => p.kind === "conveyor"));
    const conveyor = kessler?.props.find((p) => p.kind === "conveyor");
    if (kessler === undefined || conveyor === undefined) throw new Error("no conveyor");
    const { ctx, calls } = mockCanvas();
    const fills: string[] = [];
    const recording = new Proxy(ctx, {
      set(target, prop, value) {
        if (prop === "fillStyle" && typeof value === "string") fills.push(value);
        return Reflect.set(target, prop, value);
      },
      get(target, prop) {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    drawProp(recording, conveyor, {
      palette: kessler.palette,
      setting: settingOf(kessler),
      px: 0.05,
    });
    expect(calls.get("arc") ?? 0).toBe(0);
    const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const [gr = 0, gg = 0, gb = 0] = rgb(CREW_DOT_COLOR);
    for (const fill of fills.filter((f) => /^#[0-9a-f]{6}$/i.test(f))) {
      const [r = 0, g = 0, b = 0] = rgb(fill);
      expect(Math.hypot(r - gr, g - gg, b - gb), fill).toBeGreaterThan(80);
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
    const { shipAt } = berthInView(dock, layout);
    const paint = {
      origin: { x: -shipAt.x, y: -shipAt.y },
      alpha: 1,
      clamps: 0.5,
      px: 0.05,
      view: { minX: -10, minY: -10, maxX: 60, maxY: 40 },
      enclosure: 0.5,
      setting: settingOf(dock),
    };
    const { ctx } = mockCanvas();
    expect(() => {
      drawDock(ctx, dock, paint);
      drawDockForeground(ctx, dock, paint, hull.bounds, paint.view);
    }).not.toThrow();
  });
});

describe("dockShape", () => {
  it("finds the berth as the map's berth box in every map (D72)", () => {
    for (const dock of allDocks) {
      const { berth } = dockShape(dock);
      const { origin, sizeClass } = dock.berth;
      expect(berth, dock.id).toEqual({
        minX: origin.x,
        minY: origin.y,
        maxX: origin.x + HULL_SIZE_BOX[sizeClass].w,
        maxY: origin.y + HULL_SIZE_BOX[sizeClass].h,
      });
    }
  });

  it("reads each place's character off its map", () => {
    const byPort = (port: string) => {
      const dock = allDocks.find((d) => d.portId === port);
      if (dock === undefined) throw new Error(port);
      const shape = dockShape(dock);
      return { ...shape, ...dockSurface(shape, settingOf(dock)) };
    };
    // A pier out into open sky. Green Meridian's field ring fell inside its berth box at the
    // conversion (D72), so it reads as open until its map is re-authored with a field round the box.
    expect(byPort("port.green_meridian")).toMatchObject({
      berthStyle: "open",
      floorPattern: "planks",
      overSky: true,
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
