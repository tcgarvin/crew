import { describe, expect, it } from "vitest";
import { createEventBuffer } from "./events";
import { type IdHost, initialIdCounters } from "./ids";
import type { EventDraft } from "./types/events";
import type { HookId } from "./types/ids";

const hookId = "k1" as HookId;

describe("event buffer", () => {
  it("stamps id, tick, seq and default significance in emission order", () => {
    const buffer = createEventBuffer();
    const host: IdHost = { nextId: initialIdCounters() };
    buffer.emit({
      type: "narratorHookRaised",
      subjectIds: [hookId],
      causeIds: [],
      source: "sim",
      payload: { hookId, kind: "quietTooLong" },
    });
    buffer.emit({
      type: "narratorHookResolved",
      subjectIds: [hookId],
      causeIds: [],
      source: "system",
      significance: "narrative",
      payload: { hookId },
      locationRef: { kind: "port", portId: "port.x" as never },
    });
    const events = buffer.finalize(host, 12);
    expect(events.map((e) => [e.id, e.tick, e.seq, e.significance])).toEqual([
      ["e1", 12, 0, "trace"],
      ["e2", 12, 1, "narrative"],
    ]);
    expect("locationRef" in (events[0] as object)).toBe(false);
    expect(events[1]?.locationRef).toEqual({ kind: "port", portId: "port.x" });
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
    expect(host.nextId.event).toBe(3);
  });

  it("empties after finalize", () => {
    const buffer = createEventBuffer();
    const host: IdHost = { nextId: initialIdCounters() };
    const draft: EventDraft = {
      type: "invariantViolated",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      payload: { invariant: "x", detail: "y" },
    };
    buffer.emit(draft);
    expect(buffer.size()).toBe(1);
    expect(buffer.finalize(host, 1)).toHaveLength(1);
    expect(buffer.finalize(host, 2)).toEqual([]);
  });

  it("exposes nothing to read back through emit", () => {
    const { emit } = createEventBuffer();
    expect(
      emit({
        type: "invariantViolated",
        subjectIds: [],
        causeIds: [],
        source: "sim",
        payload: { invariant: "x", detail: "y" },
      }),
    ).toBeUndefined();
  });
});
