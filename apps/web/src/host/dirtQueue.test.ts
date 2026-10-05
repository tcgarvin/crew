/** D82 / D14: dirt frames are applied by view tick, never ahead of it. */
import type { DeckDefId, DirtFrame, Tick } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { DirtQueue } from "./dirtQueue";

function frameAt(tick: number, fill = 0): DirtFrame {
  return {
    tick: tick as Tick,
    deckId: "deck.test" as DeckDefId,
    width: 2,
    height: 1,
    cells: new Uint8Array([fill, fill]),
    tiers: {},
  };
}

describe("DirtQueue", () => {
  it("holds a frame until playback reaches its tick", () => {
    const queue = new DirtQueue();
    queue.add(frameAt(100));
    expect(queue.takeDue(99 as Tick)).toBeUndefined();
    expect(queue.size).toBe(1);
    expect(queue.takeDue(100 as Tick)?.tick).toBe(100);
    expect(queue.size).toBe(0);
  });

  it("applies the newest frame reached and drops the older ones", () => {
    const queue = new DirtQueue();
    for (const tick of [0, 50, 100, 150]) queue.add(frameAt(tick));
    expect(queue.takeDue(120 as Tick)?.tick).toBe(100);
    // The frame ahead of playback is kept for later, and nothing new is due until then.
    expect(queue.size).toBe(1);
    expect(queue.takeDue(130 as Tick)).toBeUndefined();
    expect(queue.takeDue(150 as Tick)?.tick).toBe(150);
  });

  it("never shows a run-ahead frame, whatever order the frames arrive in", () => {
    const queue = new DirtQueue();
    queue.add(frameAt(200, 9));
    queue.add(frameAt(100, 5));
    queue.add(frameAt(300, 12));
    const shown = queue.takeDue(250 as Tick);
    expect(shown?.tick).toBe(200);
    expect(shown?.cells[0]).toBe(9);
    expect(queue.takeDue(299 as Tick)).toBeUndefined();
  });

  it("keeps the later post of two frames at the same tick", () => {
    const queue = new DirtQueue();
    queue.add(frameAt(10, 1));
    queue.add(frameAt(10, 2));
    expect(queue.size).toBe(1);
    expect(queue.takeDue(10 as Tick)?.cells[0]).toBe(2);
  });
});
