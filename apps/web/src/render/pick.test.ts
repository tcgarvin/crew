/**
 * §what-a-tap-selects: a tap picks people first, crew and locals alike, then things, then the
 * ship's rooms (§room-tiers), then the dock's places.
 */
import type {
  ActorId,
  DockDef,
  ItemDefId,
  ItemId,
  LocalId,
  LocalKey,
  RenderActor,
  RenderFrame,
  RenderLocal,
  RenderScar,
  ScarId,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { buildDeckLayout } from "./deckLayout";
import { berthInView, withDockSlide } from "./dock";
import { dockPropKey } from "./locals";
import { pickAt, roomAt } from "./pick";

const { bundle, scenarioId } = loadWebContent();
const scenario = bundle.scenarios[scenarioId];
const deck = scenario === undefined ? undefined : bundle.decks[scenario.deckId];
if (deck === undefined) throw new Error("no deck");
const layout = buildDeckLayout(deck, bundle);
const hub = Object.values(bundle.docks ?? {}).find((d) => d.portId === "port.crossroads_hub");
if (hub === undefined) throw new Error("no hub dock");
const dock: DockDef = hub;
const kiosk = dock.posts.find((p) => p.key === "queue_kiosk");
if (kiosk === undefined) throw new Error("hub has a queue kiosk");

/** Deck-frame centre of a dock tile. */
function onDeck(x: number, y: number) {
  const { shipAt } = berthInView(dock, layout);
  return { x: x - shipAt.x + 0.5, y: y - shipAt.y + 0.5 };
}

const atKiosk = onDeck(kiosk.tile.x, kiosk.tile.y);

const hal: RenderLocal = {
  id: "o1" as LocalId,
  name: "Hal Petrosyan",
  role: "berth agent",
  deckId: layout.deckId,
  ...atKiosk,
  facing: 0,
  lookSeed: 1,
  postKey: kiosk.key as LocalKey,
  carrying: 0,
};

function crew(x: number, y: number): RenderActor {
  return {
    id: "a1" as ActorId,
    name: "Jax Okonkwo",
    deckId: layout.deckId,
    x,
    y,
    onDock: true,
    actionLabel: "walking on the dock",
    passenger: false,
    wounded: false,
  };
}

/** The centre of a tile of room `key` farthest from every machine, so only the floor is there. */
function bareFloor(key: string): { x: number; y: number } {
  let best: { x: number; y: number; d: number } | undefined;
  for (const tile of layout.tiles) {
    if (tile.compartmentKey !== key) continue;
    const x = tile.x + 0.5;
    const y = tile.y + 0.5;
    const d = Math.min(...layout.machines.map((m) => Math.hypot(m.center.x - x, m.center.y - y)));
    if (best === undefined || d > best.d) best = { x, y, d };
  }
  if (best === undefined) throw new Error(`room ${key} has no floor`);
  return best;
}

function frame(
  parts: Partial<Pick<RenderFrame, "actors" | "locals" | "items" | "dockProps" | "machines">>,
  scars: readonly RenderScar[] = [],
) {
  return {
    actors: [],
    locals: [],
    items: [],
    dockProps: [],
    machines: [],
    hull: { integrity: 100, max: 100, scars, lost: false },
    ...parts,
  } as unknown as RenderFrame;
}

describe("pickAt", () => {
  it("picks the local standing at a post, not the post", () => {
    const shown = frame({ locals: [hal] });
    expect(pickAt(shown, layout, dock, 0, atKiosk.x + 0.2, atKiosk.y)).toEqual({
      kind: "local",
      id: "o1",
    });
  });

  it("picks the post when nobody stands at it", () => {
    expect(pickAt(frame({}), layout, dock, 0, atKiosk.x, atKiosk.y)).toEqual({
      kind: "post",
      id: kiosk.key,
    });
  });

  it("picks the nearer of a crew member and a local", () => {
    const shown = frame({ locals: [hal], actors: [crew(atKiosk.x + 0.6, atKiosk.y)] });
    expect(pickAt(shown, layout, dock, 0, atKiosk.x + 0.5, atKiosk.y)?.kind).toBe("actor");
    expect(pickAt(shown, layout, dock, 0, atKiosk.x + 0.05, atKiosk.y)?.kind).toBe("local");
  });

  it("picks a person over a crate or a prop on the same tile", () => {
    const shown = frame({
      locals: [hal],
      items: [
        {
          id: "i1" as ItemId,
          defId: "item.crate_general" as ItemDefId,
          name: "General freight crate",
          kind: "crate",
          cargoClass: "general",
          location: { kind: "deck", deckId: layout.deckId, ...atKiosk, onDock: true },
          count: 1,
        },
      ],
      dockProps: [
        {
          defId: "item.crate_general" as ItemDefId,
          name: "General freight crate",
          kind: "crate",
          cargoClass: "general",
          count: 2,
          deckId: layout.deckId,
          ...atKiosk,
        },
      ],
    });
    expect(pickAt(shown, layout, dock, 0, atKiosk.x, atKiosk.y)?.kind).toBe("local");
  });

  it("picks a staged prop by its key when nobody is near it", () => {
    const staging = dock.areas.find((a) => a.kind === "freightStaging");
    if (staging === undefined) throw new Error("hub has a staging area");
    const at = onDeck(staging.rect.x, staging.rect.y);
    const props: RenderFrame["dockProps"] = [
      {
        defId: "item.crate_general" as ItemDefId,
        name: "General freight crate",
        kind: "crate",
        cargoClass: "general",
        count: 2,
        deckId: layout.deckId,
        ...at,
      },
    ];
    const first = props[0];
    if (first === undefined) throw new Error("one prop");
    expect(pickAt(frame({ dockProps: props }), layout, dock, 0, at.x + 0.2, at.y)).toEqual({
      kind: "dockProp",
      id: dockPropKey(first, 0),
    });
  });

  it("picks the room on bare deck floor (§room-tiers)", () => {
    const galley = deck.compartments.find((c) => c.tags.includes("galley"));
    if (galley === undefined) throw new Error("the deck has a galley");
    const floor = bareFloor(galley.key);
    expect(pickAt(frame({}), layout, dock, 0, floor.x, floor.y)).toEqual({
      kind: "room",
      id: galley.key,
    });
    // Nothing else is there, with or without a dock alongside.
    expect(pickAt(frame({}), layout, undefined, 0, floor.x, floor.y)?.kind).toBe("room");
  });

  it("picks a machine over the floor it stands on, and a person over either", () => {
    const placement = layout.machines[0];
    if (placement === undefined) throw new Error("the deck has machines");
    const machines = [
      { id: "m1", deckId: layout.deckId, placementKey: placement.placementKey },
    ] as unknown as RenderFrame["machines"];
    const { x, y } = placement.center;
    expect(pickAt(frame({ machines }), layout, dock, 0, x, y)).toEqual({
      kind: "machine",
      id: "m1",
    });
    const shown = frame({ machines, actors: [crew(x, y)] });
    expect(pickAt(shown, layout, dock, 0, x, y)?.kind).toBe("actor");
  });

  it("picks a hull scar over the room's floor, and a person over the scar", () => {
    const galley = deck.compartments.find((c) => c.tags.includes("galley"));
    if (galley === undefined) throw new Error("the deck has a galley");
    const floor = bareFloor(galley.key);
    const scar: RenderScar = {
      id: "r1" as ScarId,
      x: Math.floor(floor.x),
      y: Math.floor(floor.y),
      patched: false,
      rock: "small",
    };
    expect(pickAt(frame({}, [scar]), layout, dock, 0, floor.x + 0.3, floor.y - 0.3)).toEqual({
      kind: "scar",
      id: "r1",
    });
    // The next tile over is floor again.
    expect(pickAt(frame({}, [scar]), layout, undefined, 0, floor.x + 1, floor.y)?.kind).not.toBe(
      "scar",
    );
    const shown = frame({ actors: [crew(floor.x, floor.y)] }, [scar]);
    expect(pickAt(shown, layout, dock, 0, floor.x, floor.y)?.kind).toBe("actor");
  });

  it("selects no room off the ship or on void", () => {
    expect(roomAt(layout, -0.5, 2.5)).toBeUndefined();
    expect(roomAt(layout, layout.width + 0.5, 2.5)).toBeUndefined();
    const voidTile = layout.tiles.find((t) => t.compartmentKey === undefined);
    if (voidTile !== undefined) {
      expect(roomAt(layout, voidTile.x + 0.5, voidTile.y + 0.5)).toBeUndefined();
    }
  });

  it("hits a local where the sliding dock drew them", () => {
    const slide = 4;
    const shown = withDockSlide(frame({ locals: [hal] }), slide);
    expect(pickAt(shown, layout, dock, slide, atKiosk.x + slide, atKiosk.y)?.kind).toBe("local");
    // Where they stand once berthed is now bare dock floor or another place, never them.
    expect(pickAt(shown, layout, dock, slide, atKiosk.x, atKiosk.y)?.kind).not.toBe("local");
  });
});
