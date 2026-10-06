import type { RenderFrame, RenderItem } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { DeckLayout } from "./deckLayout";
import {
  actorDotColor,
  crewLabelText,
  deckPiles,
  drawActorLabels,
  drawCompartmentLabels,
  drawDeckItems,
} from "./draw";
import type { ViewTransform } from "./screen";
import { mockCanvas } from "./testCanvas";

describe("crewLabelText", () => {
  it("is the first name alone, whatever they are doing (slice-4 playtest)", () => {
    expect(crewLabelText({ name: "Mara Osei" })).toBe("Mara");
    expect(crewLabelText({ name: "Halla" })).toBe("Halla");
  });
});

describe("actorDotColor", () => {
  it("draws passengers in a different colour from crew", () => {
    expect(actorDotColor({ passenger: true })).not.toBe(actorDotColor({ passenger: false }));
  });
});

const DECK = "deck.test";

function crate(id: string, x: number, offered: boolean): RenderItem {
  return {
    id: id as RenderItem["id"],
    defId: "item.crate_general" as RenderItem["defId"],
    name: "General freight crate",
    kind: "crate",
    cargoClass: "general",
    jobId: "job:1",
    ...(offered ? { offered: true as const } : {}),
    location: { kind: "deck", deckId: DECK, x, y: 0.5, onDock: true },
    count: 1,
  } as RenderItem;
}

function frameOf(items: RenderItem[]): RenderFrame {
  return { items } as unknown as RenderFrame;
}

describe("offered freight (D63)", () => {
  it("never piles a crate on offer with taken freight of the same kind on one tile", () => {
    const piles = deckPiles(
      frameOf([crate("a", 0.5, true), crate("b", 0.5, true), crate("c", 0.5, false)]),
      DECK,
    );
    expect(piles).toHaveLength(2);
    const offered = piles.find((p) => p.top.offered === true);
    const taken = piles.find((p) => p.top.offered !== true);
    expect(offered?.count).toBe(2);
    expect(taken?.count).toBe(1);
  });

  it("draws a crate on offer with a dashed outline and taken freight without one", () => {
    const layout = { deckId: DECK } as unknown as DeckLayout;
    const t: ViewTransform = { scale: 20, offsetX: 0, offsetY: 0 };
    const offered = mockCanvas();
    drawDeckItems(offered.ctx, t, layout, frameOf([crate("a", 0.5, true)]), false, 800);
    expect(offered.calls.get("setLineDash")).toBeGreaterThan(0);
    const taken = mockCanvas();
    drawDeckItems(taken.ctx, t, layout, frameOf([crate("c", 0.5, false)]), false, 800);
    expect(taken.calls.get("setLineDash") ?? 0).toBe(0);
  });
});

describe("person labels (D72)", () => {
  const t: ViewTransform = { scale: 12, offsetX: 0, offsetY: 0 };
  const mara = {
    id: "a1",
    name: "Mara Osei",
    deckId: DECK,
    x: 10,
    y: 10,
    onDock: false,
    facing: 0,
    actionLabel: "idle",
    passenger: false,
  };
  /** Mara aboard at tile (10, 10); a local on the dock still sliding in, far past the edge. */
  const greta = {
    id: "l1",
    name: "Greta Lindholm",
    role: "shift foreman",
    deckId: DECK,
    x: 200,
    y: 10,
    facing: 0,
    lookSeed: 1,
    postKey: "board",
    label: "waiting for a delivery",
    carrying: 0,
  };
  const frameWith = (actors: object[], locals: object[], sessions: object[] = []) =>
    ({ actors, locals, items: [], sessions }) as unknown as RenderFrame;

  it("labels only the people whose dots are on the canvas", () => {
    const { ctx, texts } = mockCanvas();
    drawActorLabels(ctx, t, frameWith([mara], [greta]), false, 400, 300);
    expect(texts.map((x) => x.text)).toEqual(["Mara"]);
  });

  it("labels a local once the dock has brought them onto the canvas", () => {
    const { ctx, texts } = mockCanvas();
    drawActorLabels(ctx, t, frameWith([mara], [greta]), false, 2600, 300);
    expect(texts.map((x) => x.text).sort()).toEqual(["Greta", "Mara"]);
  });

  it("keeps a label for someone at the top edge on the canvas", () => {
    const { ctx, texts } = mockCanvas();
    drawActorLabels(ctx, t, frameWith([{ ...mara, y: 0.2 }], []), false, 400, 300);
    expect(texts[0]?.y).toBeGreaterThan(0);
  });

  describe("group sessions (slice 4, call 17)", () => {
    const jax = { ...mara, id: "jax", name: "Jax Okonkwo", x: 6.5, y: 4.5 };
    const tomas = { ...mara, id: "tomas", name: "Tomas Ruiz", x: 7.5, y: 4.5 };
    const cards = {
      id: "session:1",
      activityId: "activity.cards",
      label: "playing cards",
      x: 7,
      y: 5,
      memberIds: ["jax", "tomas"],
      running: true,
    };

    it("draws one plate for the game and no name labels for its players", () => {
      const { ctx, texts } = mockCanvas();
      drawActorLabels(ctx, t, frameWith([jax, tomas, mara], [], [cards]), false, 400, 300);
      expect(texts.map((x) => x.text).sort()).toEqual(["Mara", "cards — Jax, Tomas"]);
    });

    it("puts the plate over the venue, clear of the other labels", () => {
      const { ctx, texts } = mockCanvas();
      const near = { ...mara, x: 7, y: 5.2 };
      drawActorLabels(ctx, t, frameWith([jax, tomas, near], [], [cards]), false, 400, 300);
      const plate = texts.find((x) => x.text.startsWith("cards"));
      const other = texts.find((x) => x.text.startsWith("Mara"));
      // The session plate is placed first, in its preferred spot just above the venue centre.
      expect(plate?.x).toBeCloseTo(7 * 12);
      expect(plate?.y).toBeLessThan(5 * 12);
      expect(other?.y).not.toBeCloseTo(plate?.y ?? Number.NaN);
    });

    it("labels a gathering game with its waiting label", () => {
      const { ctx, texts } = mockCanvas();
      const waiting = {
        ...cards,
        label: "waiting for a game of cards",
        memberIds: ["jax"],
        running: false,
      };
      drawActorLabels(ctx, t, frameWith([jax, tomas], [], [waiting]), false, 400, 300);
      expect(texts.map((x) => x.text).sort()).toEqual([
        "Tomas",
        "waiting for a game of cards — Jax",
      ]);
    });
  });
});

describe("compartment labels (D72)", () => {
  /**
   * A 10×6 deck: a roomy hold, a galley one tile deep beside it, and a corridor whose bounding
   * box's top-left corner lies in the hold.
   *
   *   HHHHHHGGGG
   *   HHHHHH....
   *   HHHHHHCCCC
   *   HHHHHHCCCC
   *   CCCCCCCCCC
   *   CCCCCCCCCC
   */
  const rows = ["HHHHHHGGGG", "HHHHHH....", "HHHHHHCCCC", "HHHHHHCCCC", "CCCCCCCCCC", "CCCCCCCCCC"];
  const keyOf: Readonly<Record<string, string>> = { H: "hold", G: "galley", C: "corridor" };
  const tiles = rows.flatMap((row, y) =>
    [...row].map((ch, x) => ({ x, y, compartmentKey: keyOf[ch] })),
  );
  const boxes: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> = {};
  for (const tile of tiles) {
    if (tile.compartmentKey === undefined) continue;
    const box = boxes[tile.compartmentKey];
    boxes[tile.compartmentKey] = {
      minX: Math.min(box?.minX ?? tile.x, tile.x),
      minY: Math.min(box?.minY ?? tile.y, tile.y),
      maxX: Math.max(box?.maxX ?? tile.x + 1, tile.x + 1),
      maxY: Math.max(box?.maxY ?? tile.y + 1, tile.y + 1),
    };
  }
  const layout = {
    tiles,
    compartmentNames: { hold: "Cargo hold", galley: "Galley", corridor: "Corridor" },
    compartmentTags: {},
    compartmentBoxes: boxes,
  } as unknown as DeckLayout;
  const labels = (scale: number, rotated: boolean): string[] => {
    const { ctx, texts } = mockCanvas();
    drawCompartmentLabels(ctx, { scale, offsetX: 0, offsetY: 0 }, layout, rotated, 400);
    return texts.map((x) => x.text);
  };

  it("drops a plate taller than its room, and one whose corner is in a neighbour", () => {
    // At 12 px a tile the galley is 12 px deep, under the 14 px plate; the corridor's corner
    // is the hold's.
    expect(labels(12, false)).toEqual(["CARGO HOLD"]);
  });

  it("labels the galley once it is deep enough on screen for its plate", () => {
    expect(labels(20, false)).toEqual(["CARGO HOLD", "GALLEY"]);
  });

  it("checks the room on screen when the deck is turned a quarter", () => {
    // Turned, the galley is one tile wide on screen and the corridor's screen corner its own.
    expect(labels(20, true)).toEqual(["CARGO HOLD", "CORRIDOR"]);
  });
});
