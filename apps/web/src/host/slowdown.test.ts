import type { SimEvent, Tick } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { SlowdownQueue, slowdownToast, worthSlowingFor } from "./slowdown";

const LIST = ["navHazard", "faultOccurred", "helmUnattended", "driftingChanged"];
/** A cooldown of 100 ticks (5 s at 20 Hz) for the tests. */
const COOLDOWN = 100;
const queueOf = (list: readonly string[]) => new SlowdownQueue(list, COOLDOWN);

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

describe("auto-slowdown queue (§auto-slowdown)", () => {
  it("queues only the listed event types", () => {
    const queue = queueOf(LIST);
    queue.add([event("bell", 10), hazard(20), event("conversation", 30)]);
    expect(queue.size).toBe(1);
  });

  it("acts on an event only once playback reaches its tick, though the worker ran ahead", () => {
    const queue = queueOf(LIST);
    queue.add([hazard(400), event("faultOccurred", 600)]);
    expect(queue.takeDue(399 as Tick)).toEqual([]);
    expect(queue.takeDue(400 as Tick).map((m) => m.event.type)).toEqual(["navHazard"]);
    // Taken once: the same view tick again finds nothing more.
    expect(queue.takeDue(400 as Tick)).toEqual([]);
    expect(queue.takeDue(650 as Tick).map((m) => m.event.type)).toEqual(["faultOccurred"]);
    expect(queue.size).toBe(0);
  });

  it("hands back everything playback jumped past in one step, oldest first", () => {
    const queue = queueOf(LIST);
    queue.add([event("helmUnattended", 30)]);
    queue.add([event("faultOccurred", 10), event("driftingChanged", 20, { drifting: true })]);
    expect(queue.takeDue(100 as Tick).map((m) => m.event.tick)).toEqual([10, 20, 30]);
  });

  it("an empty list never slows anything", () => {
    const queue = queueOf([]);
    queue.add([hazard(1), event("faultOccurred", 2)]);
    expect(queue.size).toBe(0);
  });
});

describe("whether to slow down (§auto-slowdown)", () => {
  const due = [{ event: hazard(5) }];

  it("drops fast-forward to 1× when an event falls due", () => {
    expect(queueOf(LIST).shouldSlowDown(due, 5 as Tick, 8, false)).toBe(true);
    expect(queueOf(LIST).shouldSlowDown(due, 5 as Tick, 2, false)).toBe(true);
  });

  it("leaves 1× and a paused game alone", () => {
    expect(queueOf(LIST).shouldSlowDown(due, 5 as Tick, 1, false)).toBe(false);
    expect(queueOf(LIST).shouldSlowDown(due, 5 as Tick, 8, true)).toBe(false);
    expect(queueOf(LIST).shouldSlowDown([], 5 as Tick, 8, false)).toBe(false);
  });

  it("does not slow again within the cooldown of the last slowdown", () => {
    const queue = queueOf(LIST);
    expect(queue.shouldSlowDown(due, 1000 as Tick, 8, false)).toBe(true);
    expect(queue.shouldSlowDown(due, 1099 as Tick, 8, false)).toBe(false);
    expect(queue.shouldSlowDown(due, 1100 as Tick, 8, false)).toBe(true);
  });

  it("a cooldown that never slowed (at 1×) does not start one", () => {
    const queue = queueOf(LIST);
    expect(queue.shouldSlowDown(due, 1000 as Tick, 1, false)).toBe(false);
    expect(queue.shouldSlowDown(due, 1010 as Tick, 8, false)).toBe(true);
  });

  it("carries no cooldown back past a new game or a loaded save", () => {
    const queue = queueOf(LIST);
    expect(queue.shouldSlowDown(due, 5000 as Tick, 8, false)).toBe(true);
    expect(queue.shouldSlowDown(due, 20 as Tick, 8, false)).toBe(true);
  });

  it("says why in the toast", () => {
    expect(slowdownToast("Debris field: Noor Haddad took us through clean")).toBe(
      "Slowed to 1×: Debris field: Noor Haddad took us through clean",
    );
  });
});

describe("only news worth stopping for (§auto-slowdown)", () => {
  it("slows for the engines going down, not for them coming back", () => {
    expect(worthSlowingFor(event("driftingChanged", 1, { drifting: true }))).toBe(true);
    expect(worthSlowingFor(event("driftingChanged", 2, { drifting: false }))).toBe(false);
    const queue = queueOf(LIST);
    queue.add([event("driftingChanged", 2, { drifting: false })]);
    expect(queue.size).toBe(0);
  });

  it("slows for every hazard, whatever the outcome", () => {
    expect(worthSlowingFor(hazard(3))).toBe(true);
  });

  it("rejects a negative cooldown", () => {
    expect(() => new SlowdownQueue(LIST, -1)).toThrow(RangeError);
  });
});
