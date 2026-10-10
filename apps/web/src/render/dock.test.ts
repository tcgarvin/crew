import type {
  ActorId,
  BerthedDock,
  DeckDefId,
  DockDef,
  DockDefId,
  ItemDefId,
  ItemId,
  PortDefId,
  RenderActor,
  RenderFrame,
  RenderItem,
  RenderTravel,
  TravelStage,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { cameraBounds } from "./camera";
import { buildDeckLayout } from "./deckLayout";
import {
  berthInView,
  clampEngagement,
  dockInView,
  dockOrigin,
  dockSlide,
  isShipTile,
  withDockSlide,
} from "./dock";
import { dockTargetAt } from "./dockHit";
import { computeFitTransform, screenToWorld, shouldRotate } from "./draw";
import { hullGeometry } from "./hull";
import { DOCKING_START_OFFSET, sceneAt } from "./scene";
import { toScreenPx } from "./screen";

const { bundle, scenarioId } = loadWebContent();
const scenario = bundle.scenarios[scenarioId];
if (scenario === undefined) throw new Error("no scenario");
const deck = bundle.decks[scenario.deckId];
if (deck === undefined) throw new Error("no deck");
const layout = buildDeckLayout(deck, bundle);
const hull = hullGeometry(layout);
const docks = bundle.docks ?? {};

function dockOf(portId: string): DockDef {
  const dock = Object.values(docks).find((d) => d.portId === portId);
  if (dock === undefined) throw new Error(`no dock for ${portId}`);
  return dock;
}

const HUB = "port.crossroads_hub" as PortDefId;
const DRIFT = "port.kessler_drift" as PortDefId;
const hubDock = dockOf(HUB);
/** The Hub with the scenario deck in its berth box, as the sim grafts it (§ship-placement). */
const hubBerth = berthInView(hubDock, layout);

function travel(
  state: TravelStage,
  progress: number,
  from: PortDefId,
  to: PortDefId,
): RenderTravel {
  return { state, progress, fromPortId: from, toPortId: to, drifting: false };
}

function actor(id: string, x: number, y: number, onDock = false): RenderActor {
  return {
    id: id as ActorId,
    name: id,
    deckId: layout.deckId,
    x,
    y,
    actionLabel: "standing",
    passenger: false,
    wounded: false,
    onDock,
  };
}

function crate(id: string, x: number, y: number, onDock = false): RenderItem {
  return {
    id: id as ItemId,
    defId: "item.crate" as ItemDefId,
    name: "crate",
    kind: "crate",
    location: { kind: "deck", deckId: layout.deckId, x, y, onDock },
    count: 1,
  };
}

function frameWith(actors: RenderActor[], items: RenderItem[], t: RenderTravel): RenderFrame {
  return {
    tick: 0 as RenderFrame["tick"],
    actors,
    machines: [],
    doors: [],
    travel: t,
    tickerEvents: [],
    money: 0,
    items,
    headline: "",
    locals: [],
    dockProps: [],
    sessions: [],
    hull: { integrity: 100, max: 100, scars: [], lost: false },
    alert: false,
    impacts: [],
    shots: [],
  };
}

/** Deck-frame centre of a dock tile, as the sim grafts it. */
function onDeck(berth: BerthedDock, x: number, y: number) {
  return { x: x - berth.shipAt.x + 0.5, y: y - berth.shipAt.y + 0.5 };
}

describe("dockInView (the render-frame seam)", () => {
  it("shows the port in view's dock at every stage", () => {
    const drift = dockOf(DRIFT);
    expect(dockInView({ travel: travel("docked", 0, HUB, HUB) }, docks)).toBe(hubDock);
    expect(dockInView({ travel: travel("undocking", 0.5, HUB, DRIFT) }, docks)).toBe(hubDock);
    expect(dockInView({ travel: travel("departing", 0.5, HUB, DRIFT) }, docks)).toBe(hubDock);
    expect(dockInView({ travel: travel("approaching", 0.5, HUB, DRIFT) }, docks)).toBe(drift);
    expect(dockInView({ travel: travel("docking", 0.5, HUB, DRIFT) }, docks)).toBe(drift);
  });

  it("has nothing for a port without a dock map, so the stand-in berth is drawn", () => {
    const none = "port.nowhere" as PortDefId;
    expect(dockInView({ travel: travel("docked", 0, none, none) }, docks)).toBeUndefined();
    expect(dockInView({ travel: travel("docked", 0, HUB, HUB) }, {})).toBeUndefined();
  });

  it("prefers the dock the frame says is alongside, and refuses one content lacks", () => {
    const drift = dockOf(DRIFT);
    // The frame's dock is the sim's truth; it wins over the port lookup.
    const alongside = { dockId: drift.id, deckId: layout.deckId };
    expect(dockInView({ travel: travel("docked", 0, HUB, HUB), dock: alongside }, docks)).toBe(
      drift,
    );
    const unknown = { dockId: "dock.nowhere" as DockDefId, deckId: layout.deckId };
    expect(() =>
      dockInView({ travel: travel("docked", 0, HUB, HUB), dock: unknown }, docks),
    ).toThrow(/unknown dock/);
  });

  it("refuses content with two maps for one port", () => {
    const twin = { ...hubDock, id: "dock.twin" as DockDefId };
    const table = { [hubDock.id]: hubDock, [twin.id]: twin };
    expect(() => dockInView({ travel: travel("docked", 0, HUB, HUB) }, table)).toThrow(/dock maps/);
  });
});

describe("dock placement", () => {
  it("grafts dock tile (0,0) at −shipAt when docked, and slides it from the fore while docking", () => {
    const docked = sceneAt(travel("docked", 0, HUB, HUB), bundle.ports, { reducedMotion: false });
    expect(dockOrigin(hubBerth, docked, layout.width)).toEqual({
      x: -hubBerth.shipAt.x,
      y: -hubBerth.shipAt.y,
    });
    const start = sceneAt(travel("docking", 0, DRIFT, HUB), bundle.ports, { reducedMotion: false });
    // The berth is ahead (negative offset), so the dock is drawn toward the bow, +x
    // (§ship-placement).
    expect(dockSlide(start, layout.width)).toBeCloseTo(-DOCKING_START_OFFSET * layout.width);
    expect(dockOrigin(hubBerth, start, layout.width).x).toBeGreaterThan(-hubBerth.shipAt.x + 40);
  });

  it("tells the ship's floor from the dock's, negative coordinates included", () => {
    expect(isShipTile(layout, 0.5, 0.5)).toBe(true);
    expect(isShipTile(layout, layout.width - 0.5, layout.height - 0.5)).toBe(true);
    expect(isShipTile(layout, -0.5, 5.5)).toBe(false);
    expect(isShipTile(layout, 3.5, -0.5)).toBe(false);
    expect(isShipTile(layout, 3.5, layout.height + 0.5)).toBe(false);
    expect(isShipTile(layout, layout.width + 0.5, 3.5)).toBe(false);
  });
});

describe("withDockSlide", () => {
  const stall = hubDock.posts.find((p) => p.kind === "marketStall");
  if (stall === undefined) throw new Error("hub has a stall");
  // The night-market stall is west of the ship: negative deck x.
  const atStall = onDeck(hubBerth, stall.tile.x, stall.tile.y);
  const t = travel("docking", 0.5, DRIFT, HUB);
  const frame = frameWith(
    [actor("aboard", 10.5, 5.5), actor("local", atStall.x, atStall.y, true)],
    [crate("hold", 12.5, 14.5), crate("staged", atStall.x + 1, atStall.y, true)],
    t,
  );

  it("moves people and crates on the dock with it, and nobody aboard", () => {
    expect(atStall.x).toBeLessThan(0);
    const slid = withDockSlide(frame, -7.5);
    expect(slid.actors[0]).toEqual(frame.actors[0]);
    expect(slid.actors[1]?.x).toBeCloseTo(atStall.x - 7.5);
    expect(slid.actors[1]?.y).toBe(atStall.y);
    expect(slid.items[0]).toEqual(frame.items[0]);
    const staged = slid.items[1]?.location;
    expect(staged?.kind === "deck" ? staged.x : Number.NaN).toBeCloseTo(atStall.x + 1 - 7.5);
  });

  it("returns the frame untouched when nothing slides (every docked frame)", () => {
    expect(withDockSlide(frame, 0)).toBe(frame);
  });
});

describe("dock to screen and back", () => {
  for (const [width, height] of [
    [940, 720],
    [390, 700],
  ] as const) {
    it(`puts negative-coordinate dock tiles on screen and inverts them (${width}×${height})`, () => {
      const rotated = shouldRotate(width, height, layout);
      const t = computeFitTransform(width, height, cameraBounds(hull, hubBerth, 1), rotated);
      for (const post of hubDock.posts) {
        const p = onDeck(hubBerth, post.tile.x, post.tile.y);
        const [sx, sy] = toScreenPx(t, p.x, p.y, rotated, height);
        expect(sx, post.key).toBeGreaterThanOrEqual(0);
        expect(sx, post.key).toBeLessThanOrEqual(width);
        expect(sy, post.key).toBeGreaterThanOrEqual(0);
        expect(sy, post.key).toBeLessThanOrEqual(height);
        const back = screenToWorld(t, sx, sy, rotated, height);
        expect(back.x).toBeCloseTo(p.x);
        expect(back.y).toBeCloseTo(p.y);
      }
      // The map's corners, the west one at negative x, are inside the view too.
      for (const [x, y] of [
        [0, 0],
        [hubDock.width, hubDock.height],
      ] as const) {
        const p = { x: x - hubBerth.shipAt.x, y: y - hubBerth.shipAt.y };
        const [sx, sy] = toScreenPx(t, p.x, p.y, rotated, height);
        expect(sx).toBeGreaterThanOrEqual(-0.001);
        expect(sx).toBeLessThanOrEqual(width + 0.001);
        expect(sy).toBeGreaterThanOrEqual(-0.001);
        expect(sy).toBeLessThanOrEqual(height + 0.001);
      }
    });
  }
});

describe("the portrait turn", () => {
  it("points the bow up and puts the quay on the right of a phone", () => {
    const [width, height] = [390, 700];
    const rotated = shouldRotate(width, height, layout);
    expect(rotated).toBe(true);
    const t = computeFitTransform(width, height, cameraBounds(hull, hubBerth, 1), rotated);
    const mid = layout.height / 2;
    const [, bowY] = toScreenPx(t, layout.width, mid, rotated, height);
    const [, sternY] = toScreenPx(t, 0, mid, rotated, height);
    expect(bowY).toBeLessThan(sternY);
    const [northX] = toScreenPx(t, layout.width / 2, 0, rotated, height);
    const [quayX] = toScreenPx(t, layout.width / 2, layout.height + 2, rotated, height);
    expect(quayX).toBeGreaterThan(northX);
  });
});

describe("dockTargetAt (taps on the dock)", () => {
  it("picks a post near its tile, negative coordinates included", () => {
    for (const post of hubDock.posts) {
      const p = onDeck(hubBerth, post.tile.x, post.tile.y);
      expect(dockTargetAt(hubBerth, layout, p.x + 0.2, p.y - 0.2)).toEqual({
        kind: "post",
        id: post.key,
      });
    }
  });

  it("describes bare dock floor, and ignores the ship and the bay beyond", () => {
    const staging = hubDock.areas.find((a) => a.kind === "freightStaging");
    if (staging === undefined) throw new Error("hub has staging");
    const p = onDeck(hubBerth, staging.rect.x, staging.rect.y);
    expect(dockTargetAt(hubBerth, layout, p.x, p.y)).toEqual({ kind: "dock", id: hubDock.id });
    expect(dockTargetAt(hubBerth, layout, 5.5, 5.5)).toBeUndefined();
    // Void beside the berth, astern of the ship (−x, §orientation-and-size).
    expect(dockTargetAt(hubBerth, layout, -2.5, 5.5)).toBeUndefined();
  });
});

describe("clampEngagement", () => {
  it("engages at the end of docking, holds while berthed, releases early in undocking", () => {
    expect(clampEngagement(travel("docking", 0, DRIFT, HUB))).toBe(0);
    expect(clampEngagement(travel("docking", 0.7, DRIFT, HUB))).toBe(0);
    expect(clampEngagement(travel("docking", 1, DRIFT, HUB))).toBe(1);
    expect(clampEngagement(travel("docked", 0, HUB, HUB))).toBe(1);
    expect(clampEngagement(travel("preparingDeparture", 0.5, HUB, DRIFT))).toBe(1);
    expect(clampEngagement(travel("undocking", 0, HUB, DRIFT))).toBe(1);
    expect(clampEngagement(travel("undocking", 0.5, HUB, DRIFT))).toBe(0);
    expect(clampEngagement(travel("departing", 0.1, HUB, DRIFT))).toBe(0);
  });
});
