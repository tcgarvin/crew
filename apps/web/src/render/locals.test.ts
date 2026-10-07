/**
 * D68: the dock's own people and the staging call's props, drawn at every authored dock, styled
 * from a look seed that never reads as crew or passenger.
 */
import type {
  DockDef,
  ItemDefId,
  LocalId,
  LocalKey,
  PortDefId,
  RenderDockProp,
  RenderFrame,
  RenderLocal,
  RenderTravel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { cameraBounds } from "./camera";
import { buildDeckLayout } from "./deckLayout";
import { berthInView, clampEngagement, dockInView, withDockSlide } from "./dock";
import {
  CREW_DOT_COLOR,
  PASSENGER_DOT_COLOR,
  PASSENGER_RIM_COLOR,
  computeFitTransform,
  drawActorLabels,
  drawFrame,
  shouldRotate,
} from "./draw";
import { hullGeometry } from "./hull";
import {
  LOCAL_PALETTE,
  dockPropColor,
  dockPropKey,
  drawDockProps,
  drawLocalDots,
  drawLocalTrolleys,
  localLabelText,
  localLook,
} from "./locals";
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

/** Deck-frame centre of a dock tile, as the sim places people and props (D59, D66). */
function onDeck(dock: DockDef, x: number, y: number) {
  const { shipAt } = berthInView(dock, layout);
  return { x: x - shipAt.x + 0.5, y: y - shipAt.y + 0.5 };
}

function local(overrides: Partial<Omit<RenderLocal, "id">> & { id: string }): RenderLocal {
  return {
    name: "Hal Petrosyan",
    role: "berth agent",
    deckId: layout.deckId,
    x: 0,
    y: 0,
    facing: 0,
    lookSeed: 12345,
    postKey: "queue_kiosk" as LocalKey,
    carrying: 0,
    ...overrides,
    id: overrides.id as LocalId,
  };
}

function prop(overrides: Partial<RenderDockProp>): RenderDockProp {
  return {
    defId: "item.crate_general" as ItemDefId,
    name: "General freight crate",
    kind: "crate",
    cargoClass: "general",
    count: 2,
    deckId: layout.deckId,
    x: 0.5,
    y: 0.5,
    ...overrides,
  };
}

/** Somebody at every post (every other one labelled), a dock hand carting three, and props. */
function dockside(dock: DockDef): Pick<RenderFrame, "locals" | "dockProps"> {
  const locals = dock.posts.map((post, i) =>
    local({
      id: `o${i + 1}`,
      name: `Local ${i}`,
      postKey: post.key,
      lookSeed: i * 2654435761,
      ...onDeck(dock, post.tile.x, post.tile.y),
      ...(i % 2 === 0 ? { label: "waiting by three crates" } : {}),
    }),
  );
  const door = dock.posts.find((p) => p.kind === "warehouseDoor") ?? dock.posts[0];
  if (door !== undefined) {
    locals.push(
      local({
        id: "o99",
        name: "Ilse Brandt",
        role: "dock hand",
        postKey: door.key,
        ...onDeck(dock, door.tile.x, door.tile.y - 1),
        label: "bringing out 3 crates",
        carrying: 3,
      }),
    );
  }
  const dockProps = dock.areas.map((area, i) =>
    prop({ count: (i % 4) + 1, ...onDeck(dock, area.rect.x + 1, area.rect.y + 1) }),
  );
  return { locals, dockProps };
}

function frameAt(dock: DockDef, travel: RenderTravel, withDockside: boolean): RenderFrame {
  return {
    tick: 0,
    actors: [],
    machines: [],
    doors: [],
    travel,
    tickerEvents: [],
    money: 0,
    items: [],
    headline: "",
    sessions: [],
    hull: { integrity: 100, max: 100, scars: [], lost: false },
    alert: false,
    impacts: [],
    ...(withDockside ? dockside(dock) : { locals: [], dockProps: [] }),
    ...(travel.state === "departing" ? {} : { dock: { dockId: dock.id, deckId: layout.deckId } }),
  };
}

function render(dock: DockDef, travel: RenderTravel, width: number, height: number, on: boolean) {
  const canvas = mockCanvas();
  const shown = dockInView(frameAt(dock, travel, on), docks);
  const scene = withDockSky(sceneAt(travel, bundle.ports, { reducedMotion: false }), shown);
  const rotated = shouldRotate(width, height, layout);
  const transform = computeFitTransform(
    width,
    height,
    cameraBounds(hull, shown === undefined ? undefined : berthInView(shown, layout), scene.cameraT),
    rotated,
  );
  drawFrame(canvas.ctx, transform, layout, frameAt(dock, travel, on), width, height, rotated, {
    scene,
    hull,
    stars,
    starScrollPx: 0,
    plume: 0,
    flicker: 0,
    dock: shown,
    clamps: clampEngagement(travel),
  });
  return canvas.calls;
}

/** Squared RGB distance between two `#rrggbb` colours. */
function distance(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [ar = 0, ag = 0, ab = 0] = rgb(a);
  const [br = 0, bg = 0, bb = 0] = rgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

describe("every dock draws its locals and props (D68)", () => {
  for (const dock of allDocks) {
    const other = allDocks.find((d) => d !== dock)?.portId ?? dock.portId;
    const moments: RenderTravel[] = [
      {
        state: "docking",
        progress: 0.4,
        fromPortId: other,
        toPortId: dock.portId,
        drifting: false,
      },
      {
        state: "docked",
        progress: 0,
        fromPortId: dock.portId,
        toPortId: dock.portId,
        drifting: false,
      },
      {
        state: "undocking",
        progress: 0.6,
        fromPortId: dock.portId,
        toPortId: other,
        drifting: false,
      },
    ];
    for (const [width, height] of [
      [940, 720],
      [390, 700],
    ] as const) {
      it(`${dock.id} at ${width}×${height}`, () => {
        for (const t of moments) {
          const bare = render(dock, t, width, height, false);
          const dressed = render(dock, t, width, height, true);
          const people = dock.posts.length + 1;
          // One dot per local, and the labelled ones' text over them.
          expect((dressed.get("arc") ?? 0) - (bare.get("arc") ?? 0), t.state).toBe(people);
          expect(dressed.get("fillText") ?? 0, t.state).toBeGreaterThan(bare.get("fillText") ?? 0);
        }
      });
    }
  }
});

describe("a local's look", () => {
  it("is the same for the same seed, every time", () => {
    for (const seed of [0, 1, 7, 2654435761, 4294967295]) {
      expect(localLook(seed)).toEqual(localLook(seed));
    }
  });

  it("varies across people", () => {
    const fills = new Set(Array.from({ length: 64 }, (_, i) => localLook(i * 2654435761).fill));
    expect(fills.size).toBeGreaterThanOrEqual(6);
  });

  it("never reads as crew gold or a passenger's pale dot and blue rim", () => {
    for (const fill of LOCAL_PALETTE) {
      expect(distance(fill, CREW_DOT_COLOR), fill).toBeGreaterThan(80);
      expect(distance(fill, PASSENGER_DOT_COLOR), fill).toBeGreaterThan(80);
    }
    for (let seed = 0; seed < 32; seed++) {
      const look = localLook(seed);
      expect(look.rim).not.toBe(PASSENGER_RIM_COLOR);
      expect(look.rim).not.toBe(look.fill);
    }
  });

  it("draws a dot with its own rim, and a ring when selected", () => {
    const t = { scale: 20, offsetX: 0, offsetY: 0 };
    const plain = mockCanvas();
    drawLocalDots(plain.ctx, t, [local({ id: "o1" })], false, 800);
    expect(plain.calls.get("arc")).toBe(1);
    expect(plain.calls.get("stroke")).toBe(1);
    const chosen = mockCanvas();
    drawLocalDots(chosen.ctx, t, [local({ id: "o1" })], false, 800, "o1");
    expect(chosen.calls.get("arc")).toBe(2);
  });
});

describe("local labels", () => {
  it("label a local only while they are doing something, by first name alone", () => {
    expect(localLabelText({ name: "Hal Petrosyan" })).toBeUndefined();
    expect(localLabelText({ name: "Hal Petrosyan", label: "waiting by three crates" })).toBe("Hal");
  });

  it("draws crew labels and busy locals' labels, not idle locals'", () => {
    const frame = {
      actors: [
        {
          id: "a1",
          name: "Mara Osei",
          deckId: layout.deckId,
          x: 3,
          y: 3,
          onDock: false,
          actionLabel: "at the helm",
          passenger: false,
        },
      ],
      items: [],
      locals: [
        local({ id: "o1", x: 3, y: 3 }),
        local({ id: "o2", x: 3.2, y: 3, label: "waiting for a delivery" }),
      ],
      sessions: [],
    } as unknown as RenderFrame;
    const { ctx, calls } = mockCanvas();
    drawActorLabels(ctx, { scale: 20, offsetX: 0, offsetY: 0 }, frame, false, 800, 600);
    expect(calls.get("fillText")).toBe(2);
  });
});

describe("a dock hand's trolley", () => {
  const t = { scale: 24, offsetX: 10, offsetY: 10 };

  it("is drawn only while carting, with each crate and a count tag", () => {
    const empty = mockCanvas();
    drawLocalTrolleys(empty.ctx, t, [local({ id: "o1" })], false, 800);
    expect(empty.calls.size).toBe(0);
    const loaded = mockCanvas();
    drawLocalTrolleys(loaded.ctx, t, [local({ id: "o1", carrying: 3 })], false, 800);
    // Three crates and the count tag's plate; the handle and toe plate as lines.
    expect(loaded.calls.get("fillRect")).toBe(4);
    expect(loaded.calls.get("fillText")).toBe(1);
    expect(loaded.calls.get("lineTo")).toBeGreaterThanOrEqual(2);
  });

  it("shows at most four crates, rotated or not", () => {
    const canvas = mockCanvas();
    drawLocalTrolleys(canvas.ctx, t, [local({ id: "o1", carrying: 6 })], true, 700);
    expect(canvas.calls.get("fillRect")).toBe(5);
  });
});

describe("staged props", () => {
  const t = { scale: 20, offsetX: 0, offsetY: 0 };

  it("draw as that many small crates, with no count tag", () => {
    for (const count of [1, 2, 3, 4]) {
      const { ctx, calls } = mockCanvas();
      drawDockProps(ctx, t, [prop({ count })], false, 800);
      expect(calls.get("fillRect"), `${count}`).toBe(count);
      expect(calls.get("fillText") ?? 0).toBe(0);
    }
  });

  it("are muted against the same item as freight, and outlined when selected", () => {
    expect(dockPropColor({ kind: "crate", cargoClass: "general" })).not.toBe("#d8ab6c");
    const props = [prop({}), prop({ x: 4.5 })];
    const { ctx, calls } = mockCanvas();
    drawDockProps(ctx, t, props, false, 800, dockPropKey(props[1] as RenderDockProp, 1));
    // Two crates each, with their outline and strap strokes, plus one selection square.
    expect(calls.get("strokeRect")).toBe(5);
  });

  it("key by their place in the frame, so the key holds while the dock slides", () => {
    const p = prop({});
    const slid: RenderDockProp = { ...p, x: p.x + 5 };
    expect(dockPropKey(p, 0)).toBe(dockPropKey(slid, 0));
    expect(dockPropKey(p, 0)).not.toBe(dockPropKey(p, 1));
  });
});

describe("withDockSlide", () => {
  it("moves the dock's people and props with it", () => {
    const hub = allDocks.find((d) => d.portId === ("port.crossroads_hub" as PortDefId));
    if (hub === undefined) throw new Error("no hub dock");
    const frame = frameAt(
      hub,
      {
        state: "docking",
        progress: 0.4,
        fromPortId: hub.portId,
        toPortId: hub.portId,
        drifting: false,
      },
      true,
    );
    const slid = withDockSlide(frame, 3);
    expect(slid.locals.map((l) => l.x)).toEqual(frame.locals.map((l) => l.x + 3));
    expect(slid.dockProps.map((p) => p.x)).toEqual(frame.dockProps.map((p) => p.x + 3));
    expect(slid.locals.map((l) => l.y)).toEqual(frame.locals.map((l) => l.y));
  });
});
