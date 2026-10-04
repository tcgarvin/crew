/** D68: a tap picks people first, crew and locals alike, then things, then the dock's places. */
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
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { buildDeckLayout } from "./deckLayout";
import { berthInView, withDockSlide } from "./dock";
import { dockPropKey } from "./locals";
import { pickAt } from "./pick";

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
  };
}

function frame(parts: Partial<Pick<RenderFrame, "actors" | "locals" | "items" | "dockProps">>) {
  return {
    actors: [],
    locals: [],
    items: [],
    dockProps: [],
    machines: [],
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

  it("hits a local where the sliding dock drew them", () => {
    const slide = 4;
    const shown = withDockSlide(frame({ locals: [hal] }), slide);
    expect(pickAt(shown, layout, dock, slide, atKiosk.x + slide, atKiosk.y)?.kind).toBe("local");
    // Where they stand once berthed is now bare dock floor or another place, never them.
    expect(pickAt(shown, layout, dock, slide, atKiosk.x, atKiosk.y)?.kind).not.toBe("local");
  });
});
