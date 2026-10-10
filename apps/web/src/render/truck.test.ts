/**
 * §hand-truck-drawing: a hand truck being pushed is drawn beside its pusher with the crates riding
 * on it (the frame's `container` items), rather than as one carried square.
 */
import type {
  ActorId,
  DeckDefId,
  ItemDefId,
  ItemId,
  PortDefId,
  RenderFrame,
  RenderItem,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { drawCarriedItems } from "./draw";
import { mockCanvas } from "./testCanvas";

const DECK = "deck.test" as DeckDefId;
const PORT = "port.test" as PortDefId;
const TRUCK = "i1" as ItemId;

function crate(n: number): RenderItem {
  return {
    id: `i${n + 1}` as ItemId,
    defId: "item.crate" as ItemDefId,
    name: "Crate",
    kind: "crate",
    cargoClass: "general",
    location: { kind: "container", containerId: TRUCK },
    count: 1,
  };
}

function frame(crates: number): RenderFrame {
  const truck: RenderItem = {
    id: TRUCK,
    defId: "item.hand_truck" as ItemDefId,
    name: "Hand Truck",
    kind: "tool",
    location: { kind: "carried", actorId: "a1" as ActorId },
    count: 1,
  };
  return {
    tick: 1,
    actors: [
      {
        id: "a1" as ActorId,
        name: "Jax",
        deckId: DECK,
        x: 4.5,
        y: 3.5,
        onDock: false,
        actionLabel: "hauling 3 crates",
        passenger: false,
      },
    ],
    machines: [],
    doors: [],
    travel: { state: "docked", progress: 0, fromPortId: PORT, toPortId: PORT, drifting: false },
    tickerEvents: [],
    money: 0,
    items: [truck, ...Array.from({ length: crates }, (_, i) => crate(i + 1))],
    headline: "",
    locals: [],
    dockProps: [],
    sessions: [],
    hull: { integrity: 100, max: 100, scars: [], lost: false },
    alert: false,
    impacts: [],
  };
}

const view = { scale: 24, offsetX: 10, offsetY: 10 };

describe("drawing the hand truck (§hand-truck-drawing)", () => {
  it("draws each crate on a pushed truck, with a count tag", () => {
    const empty = mockCanvas();
    drawCarriedItems(empty.ctx, view, frame(0), false, 800);
    const loaded = mockCanvas();
    drawCarriedItems(loaded.ctx, view, frame(3), false, 800);
    // Empty: the truck as one carried square. Loaded: three crates, the badge, the frame.
    expect(empty.calls.get("fillRect")).toBe(1);
    expect(loaded.calls.get("fillRect")).toBe(4);
    expect(loaded.calls.get("fillText")).toBe(1);
    expect(loaded.calls.get("lineTo")).toBeGreaterThanOrEqual(2);
  });

  it("draws at most four crates however many ride on it, rotated or not", () => {
    const canvas = mockCanvas();
    drawCarriedItems(canvas.ctx, view, frame(6), true, 700);
    expect(canvas.calls.get("fillRect")).toBe(5);
  });
});
