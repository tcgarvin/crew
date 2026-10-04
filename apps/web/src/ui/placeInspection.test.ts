import type { BerthedDock, DeepReadonly, DockDef, ItemId, WorldState } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDeckLayout } from "../render/deckLayout";
import { berthInView } from "../render/dock";
import { loadWebContent } from "../worker/content";
import { dockWhere, inspectItem } from "./itemInspection";
import { inspectPlace, postTitle } from "./placeInspection";

const { bundle, scenarioId } = loadWebContent();
const docks: DockDef[] = Object.values(bundle.docks ?? {});
const hub = docks.find((d) => d.portId === "port.crossroads_hub");
if (hub === undefined) throw new Error("no hub dock");

/** Deck-frame centre of a dock tile. */
function onDeck(berth: BerthedDock, x: number, y: number) {
  return { x: x - berth.shipAt.x + 0.5, y: y - berth.shipAt.y + 0.5 };
}

describe("inspectPlace", () => {
  it("names a post as a heading, with its dock and what it is for", () => {
    const kiosk = hub.posts.find((p) => p.kind === "kiosk");
    if (kiosk === undefined) throw new Error("hub has a kiosk");
    const place = inspectPlace(hub, { kind: "post", id: kiosk.key });
    expect(place.title).toBe(postTitle(kiosk.name));
    expect(place.title.startsWith("the ")).toBe(false);
    expect(place.subtitle).toBe(hub.name);
    expect(place.text.length).toBeGreaterThan(0);
  });

  it("describes the dock itself by its ambience line", () => {
    expect(inspectPlace(hub, { kind: "dock", id: hub.id })).toEqual({
      title: hub.name,
      subtitle: "the dock",
      text: hub.ambience,
    });
  });

  it("throws on a post the dock does not have", () => {
    expect(() => inspectPlace(hub, { kind: "post", id: "nope" })).toThrow(/no post/);
  });

  it("titles posts without their article", () => {
    expect(postTitle("the queue-board kiosk")).toBe("Queue-board kiosk");
    expect(postTitle("Harrow's trading-post counter")).toBe("Harrow's trading-post counter");
  });
});

describe("dockWhere (items on the dock)", () => {
  const scenario = bundle.scenarios[scenarioId];
  const deck = scenario === undefined ? undefined : bundle.decks[scenario.deckId];
  if (deck === undefined) throw new Error("no deck");
  const layout = buildDeckLayout(deck, bundle);
  /** The Hub with the scenario deck in its berth box (D72). */
  const hubBerth = berthInView(hub, layout);

  it("names the area an item sits in", () => {
    for (const area of hub.areas) {
      const p = onDeck(hubBerth, area.rect.x, area.rect.y);
      const words = dockWhere(hubBerth, p.x, p.y);
      expect(words).toMatch(area.kind === "freightStaging" ? /staging/ : /delivery bay/);
    }
  });

  it("names the nearest post at negative deck coordinates, and stays off the ship's rooms", () => {
    const stall = hub.posts.find((p) => p.kind === "marketStall");
    if (stall === undefined) throw new Error("hub has a stall");
    const p = onDeck(hubBerth, stall.tile.x, stall.tile.y);
    expect(p.x).toBeLessThan(0);
    expect(dockWhere(hubBerth, p.x, p.y)).toBe(`on the dock by ${stall.name}`);
    // Indexing the deck's tiles by y * width + x would wrap a negative x into the row above
    // and name a room; an item there is on the dock.
    const snapshot = (dock: { dockId: string; deckId: string } | undefined) =>
      ({
        items: {
          i1: {
            defId: "item.unknown",
            location: { kind: "onDeck", deckId: layout.deckId, x: p.x, y: p.y },
            stacking: "unique",
          },
        },
        deck: dock === undefined ? {} : { dock },
        defs: { dynamic: { items: {} } },
        jobs: {},
        actors: {},
      }) as unknown as DeepReadonly<WorldState>;
    const alongside = snapshot({ dockId: hub.id, deckId: layout.deckId });
    expect(inspectItem(alongside, "i1" as ItemId, bundle, layout)?.where).toBe(
      `on the dock by ${stall.name}`,
    );
    // With no dock in the snapshot the point is nowhere on the ship: plain words, not a room.
    expect(inspectItem(snapshot(undefined), "i1" as ItemId, bundle, layout)?.where).toBe("on deck");
  });

  it("falls back to plain words in the open", () => {
    const p = onDeck(hubBerth, 30, 21);
    expect(dockWhere(hubBerth, p.x, p.y)).toBe("on the dock");
  });
});
