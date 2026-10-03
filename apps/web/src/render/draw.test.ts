import type { RenderFrame, RenderItem } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { DeckLayout } from "./deckLayout";
import { type ViewTransform, actorDotColor, deckPiles, drawDeckItems } from "./draw";
import { mockCanvas } from "./testCanvas";

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
