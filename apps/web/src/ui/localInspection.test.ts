/**
 * §items-places-and-locals: the inspector's words for the dock's own people and the staging call's
 * props.
 */
import type {
  DockDef,
  ItemDefId,
  LocalId,
  LocalKey,
  RenderDockProp,
  RenderFrame,
  RenderLocal,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDeckLayout } from "../render/deckLayout";
import { berthInView } from "../render/dock";
import { dockPropKey } from "../render/locals";
import { loadWebContent } from "../worker/content";
import { dockInspection } from "./dockInspection";
import { inspectDockProp, inspectLocal } from "./localInspection";

const { bundle, scenarioId } = loadWebContent();
const docks = bundle.docks ?? {};
const hub = Object.values(docks).find((d) => d.portId === "port.crossroads_hub");
if (hub === undefined) throw new Error("no hub dock");
const dock: DockDef = hub;
const scenario = bundle.scenarios[scenarioId];
const scenarioDeck = scenario === undefined ? undefined : bundle.decks[scenario.deckId];
if (scenarioDeck === undefined) throw new Error("no scenario deck");
const layout = buildDeckLayout(scenarioDeck, bundle);
/** The Hub with the scenario deck in its berth box (§ship-placement). */
const berth = berthInView(dock, layout);

function onDeck(x: number, y: number) {
  return { x: x - berth.shipAt.x + 0.5, y: y - berth.shipAt.y + 0.5 };
}

function post(key: string) {
  const found = dock.posts.find((p) => p.key === key);
  if (found === undefined) throw new Error(`hub has no ${key}`);
  return found;
}

function local(overrides: Partial<RenderLocal>): RenderLocal {
  const kiosk = post("queue_kiosk");
  return {
    id: "o1" as LocalId,
    name: "Hal Petrosyan",
    role: "berth agent",
    deckId: "deck.test" as RenderLocal["deckId"],
    ...onDeck(kiosk.tile.x, kiosk.tile.y),
    facing: 0,
    lookSeed: 1,
    postKey: kiosk.key as LocalKey,
    carrying: 0,
    ...overrides,
  };
}

const crates: RenderDockProp = {
  defId: "item.crate_general" as ItemDefId,
  name: "General freight crate",
  kind: "crate",
  cargoClass: "general",
  count: 3,
  deckId: "deck.test" as RenderDockProp["deckId"],
  ...onDeck(20, 25),
};

describe("inspectLocal", () => {
  it("names a regular at their post: Hal at the queue kiosk", () => {
    expect(inspectLocal(berth, local({}))).toEqual({
      name: "Hal Petrosyan",
      role: "berth agent",
      where: "at the queue-board kiosk",
    });
  });

  it("still says at their post while they shuffle about it", () => {
    const kiosk = post("queue_kiosk");
    const near = local(onDeck(kiosk.tile.x + 1, kiosk.tile.y - 1));
    expect(inspectLocal(berth, near).where).toBe("at the queue-board kiosk");
  });

  it("says where a dock hand is and what they are doing when away from their post", () => {
    const hand = local({
      name: "Ilse Brandt",
      role: "dock hand",
      postKey: "dispatch" as LocalKey,
      label: "bringing out 3 crates",
      carrying: 3,
      ...onDeck(20, 25),
    });
    expect(inspectLocal(berth, hand)).toEqual({
      name: "Ilse Brandt",
      role: "dock hand",
      where: "in the freight staging area on the dock",
      post: "the Co-op dispatch window",
      doing: "bringing out 3 crates",
    });
  });

  it("carries a new face's look line", () => {
    expect(inspectLocal(berth, local({ look: "a courier in a rain-dark coat" })).look).toBe(
      "a courier in a rain-dark coat",
    );
  });

  it("throws on a post the dock does not have", () => {
    expect(() => inspectLocal(berth, local({ postKey: "nope" as LocalKey }))).toThrow(/no post/);
  });
});

describe("inspectDockProp", () => {
  it("says how many, where, and whose", () => {
    expect(inspectDockProp(berth, crates)).toEqual({
      title: "General freight crate",
      subtitle: "on the dock",
      text: "Three of them, in the freight staging area on the dock. The port's, not the ship's.",
    });
  });

  it("needs no count for one", () => {
    expect(inspectDockProp(berth, { ...crates, count: 1 }).text).toBe(
      "In the freight staging area on the dock. The port's, not the ship's.",
    );
  });
});

describe("dockInspection", () => {
  const frame = {
    travel: {
      state: "docked",
      progress: 0,
      fromPortId: dock.portId,
      toPortId: dock.portId,
      drifting: false,
    },
    dock: { dockId: dock.id, deckId: "deck.test" },
    locals: [local({})],
    dockProps: [crates],
  } as unknown as RenderFrame;

  it("finds the tapped local and prop in the frame", () => {
    expect(dockInspection(frame, docks, layout, { kind: "local", id: "o1" })).toMatchObject({
      kind: "local",
      local: { name: "Hal Petrosyan" },
    });
    expect(
      dockInspection(frame, docks, layout, { kind: "dockProp", id: dockPropKey(crates, 0) }),
    ).toMatchObject({ kind: "place", place: { title: "General freight crate" } });
  });

  it("has nothing to show for someone who has left the dock", () => {
    expect(dockInspection(frame, docks, layout, { kind: "local", id: "o9" })).toBeUndefined();
  });
});
