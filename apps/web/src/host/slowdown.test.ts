import type { SimEvent, Tick } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { SlowdownQueue, shouldSlowDown, slowdownToast } from "./slowdown";

const LIST = ["navHazard", "faultOccurred", "helmUnattended", "driftingChanged"];

let seq = 0;
function event(type: string, tick: number, payload: unknown = {}): SimEvent {
  seq += 1;
  return {
    id: `evt:${seq}`,
    tick: tick as Tick,
    seq,
    type,
    subjectIds: [],
    significance: "notable",
    payload,
  } as unknown as SimEvent;
}

const hazard = (tick: number) =>
  event("navHazard", tick, {
    hazardId: "hazard:1",
    kind: "debrisField",
    difficulty: 5,
    skill: 6,
    outcome: "clean",
    lostSeconds: 0,
  });

describe("auto-slowdown queue (D76)", () => {
  it("queues only the listed event types", () => {
    const queue = new SlowdownQueue(LIST);
    queue.add([event("bell", 10), hazard(20), event("conversation", 30)]);
    expect(queue.size).toBe(1);
  });

  it("acts on an event only once playback reaches its tick, though the worker ran ahead", () => {
    const queue = new SlowdownQueue(LIST);
    queue.add([hazard(400), event("faultOccurred", 600)]);
    expect(queue.takeDue(399 as Tick)).toEqual([]);
    expect(queue.takeDue(400 as Tick).map((m) => m.event.type)).toEqual(["navHazard"]);
    // Taken once: the same view tick again finds nothing more.
    expect(queue.takeDue(400 as Tick)).toEqual([]);
    expect(queue.takeDue(650 as Tick).map((m) => m.event.type)).toEqual(["faultOccurred"]);
    expect(queue.size).toBe(0);
  });

  it("hands back everything playback jumped past in one step, oldest first", () => {
    const queue = new SlowdownQueue(LIST);
    queue.add([event("helmUnattended", 30)]);
    queue.add([event("faultOccurred", 10), event("driftingChanged", 20)]);
    expect(queue.takeDue(100 as Tick).map((m) => m.event.tick)).toEqual([10, 20, 30]);
  });

  it("an empty list never slows anything", () => {
    const queue = new SlowdownQueue([]);
    queue.add([hazard(1), event("faultOccurred", 2)]);
    expect(queue.size).toBe(0);
  });
});

describe("whether to slow down (D76)", () => {
  const due = [{ event: hazard(5) }];

  it("drops fast-forward to 1× when an event falls due", () => {
    expect(shouldSlowDown(due, 8, false)).toBe(true);
    expect(shouldSlowDown(due, 2, false)).toBe(true);
  });

  it("leaves 1× and a paused game alone", () => {
    expect(shouldSlowDown(due, 1, false)).toBe(false);
    expect(shouldSlowDown(due, 8, true)).toBe(false);
    expect(shouldSlowDown([], 8, false)).toBe(false);
  });

  it("says why in the toast", () => {
    expect(slowdownToast("Debris field: Noor Haddad took us through clean")).toBe(
      "Slowed to 1×: Debris field: Noor Haddad took us through clean",
    );
  });
});
