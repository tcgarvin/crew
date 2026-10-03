import type { Decision, Tick, TickerEntry } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  LOG_LIMIT,
  type LogEntry,
  answerDecision,
  appendDecision,
  appendTicker,
  visibleLog,
} from "./log";

function line(tick: number, text: string): TickerEntry {
  return { tick: tick as Tick, text, significance: "notable" };
}

function decision(id: string, createdTick: number): Decision {
  return {
    id: id as never,
    origin: "policy",
    perspectiveActorId: "a1" as never,
    prompt: { key: "job.offer", params: {} },
    left: { label: { key: "job.offer.accept", params: {} }, commands: [] },
    right: { label: { key: "job.offer.decline", params: {} }, commands: [] },
    status: "pending",
    createdTick: createdTick as Tick,
  };
}

function texts(entries: readonly LogEntry[]): string[] {
  return entries.map((e) => (e.kind === "event" ? e.text : `card ${e.decision.id}`));
}

describe("the ship's log (D55)", () => {
  it("shows only what playback has reached, newest first, though the worker runs ahead", () => {
    const log = appendTicker([], [line(10, "a"), line(20, "b"), line(400, "far ahead")]);
    expect(texts(visibleLog(log, 0 as Tick))).toEqual([]);
    expect(texts(visibleLog(log, 20 as Tick))).toEqual(["b", "a"]);
    expect(texts(visibleLog(log, 400 as Tick))).toEqual(["far ahead", "b", "a"]);
  });

  it("puts cards in tick order among the event lines", () => {
    let log = appendTicker([], [line(10, "a"), line(30, "c")]);
    log = appendDecision(log, decision("d1", 20));
    expect(texts(visibleLog(log, 30 as Tick))).toEqual(["c", "card d1", "a"]);
  });

  it("logs a card once and records the captain's answer on it", () => {
    let log = appendDecision([], decision("d1", 5));
    log = appendDecision(log, decision("d1", 5));
    expect(log).toHaveLength(1);
    log = answerDecision(log, "d1", { side: "left", caption: "Taken." });
    expect(log[0]).toMatchObject({ kind: "card", answer: { side: "left", caption: "Taken." } });
  });

  it("keeps at most LOG_LIMIT entries, dropping the oldest", () => {
    const many = Array.from({ length: LOG_LIMIT + 5 }, (_, i) => line(i, `e${i}`));
    const log = appendTicker([], many);
    expect(log).toHaveLength(LOG_LIMIT);
    expect(texts(log)[0]).toBe("e5");
  });
});
