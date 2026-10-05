import type { Decision, Tick, TickerEntry } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  LOG_LIMIT,
  type LogEntry,
  answerDecision,
  appendDecision,
  appendTicker,
  clearHighlights,
  highlightEvent,
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

  it("logs a card delivered in person at its meeting, not when it was made (D70)", () => {
    const held = { ...decision("d1", 20), deliveredTick: 60 as Tick };
    const log = appendDecision([], held);
    expect(texts(visibleLog(log, 59 as Tick))).toEqual([]);
    expect(texts(visibleLog(log, 60 as Tick))).toEqual(["card d1"]);
  });

  it("logs a card once and records the captain's answer on it", () => {
    let log = appendDecision([], decision("d1", 5));
    log = appendDecision(log, decision("d1", 5));
    expect(log).toHaveLength(1);
    log = answerDecision(log, "d1", { side: "left", caption: "Taken." });
    expect(log[0]).toMatchObject({ kind: "card", answer: { side: "left", caption: "Taken." } });
  });

  it("highlights the line that slowed the game, matched by tick and text (D76)", () => {
    const log = appendTicker(
      [],
      [line(10, "Coolant pump: seized bearing"), line(10, "Coolant pump at 50% (fault)")],
    );
    const { log: marked, found } = highlightEvent(log, 10 as Tick, "Coolant pump: seized bearing");
    expect(found).toBe(true);
    expect(marked.map((e) => (e.kind === "event" ? (e.highlight ?? false) : false))).toEqual([
      true,
      false,
    ]);
    // The input is not mutated.
    expect(log.every((e) => e.kind !== "event" || e.highlight === undefined)).toBe(true);
  });

  it("marks a second identical line in the same tick on the second slowdown (D76)", () => {
    const log = appendTicker([], [line(5, "Nobody at the helm"), line(5, "Nobody at the helm")]);
    const once = highlightEvent(log, 5 as Tick, "Nobody at the helm").log;
    const twice = highlightEvent(once, 5 as Tick, "Nobody at the helm").log;
    expect(twice.filter((e) => e.kind === "event" && e.highlight === true)).toHaveLength(2);
  });

  it("reports a slowdown whose line is not in the log rather than marking another (D76)", () => {
    const log = appendTicker([], [line(10, "Bell.")]);
    const result = highlightEvent(log, 11 as Tick, "Bell.");
    expect(result.found).toBe(false);
    expect(result.log).toBe(log);
  });

  it("puts the highlighted line first among its tick's lines, so the compact log shows it", () => {
    const log = appendTicker(
      [],
      [line(4, "earlier"), line(10, "Coolant pump: worn bearing"), line(10, "Coolant pump at 50%")],
    );
    expect(texts(visibleLog(log, 10 as Tick))).toEqual([
      "Coolant pump at 50%",
      "Coolant pump: worn bearing",
      "earlier",
    ]);
    const marked = highlightEvent(log, 10 as Tick, "Coolant pump: worn bearing").log;
    expect(texts(visibleLog(marked, 10 as Tick))).toEqual([
      "Coolant pump: worn bearing",
      "Coolant pump at 50%",
      "earlier",
    ]);
  });

  it("clears every highlight, leaving an unmarked log as it was (D76 addendum)", () => {
    const log = appendTicker([], [line(1, "a"), line(2, "b")]);
    expect(clearHighlights(log)).toBe(log);
    const marked = highlightEvent(log, 2 as Tick, "b").log;
    const cleared = clearHighlights(marked);
    expect(cleared.some((e) => e.kind === "event" && e.highlight === true)).toBe(false);
    expect(texts(cleared)).toEqual(["a", "b"]);
  });

  it("keeps at most LOG_LIMIT entries, dropping the oldest", () => {
    const many = Array.from({ length: LOG_LIMIT + 5 }, (_, i) => line(i, `e${i}`));
    const log = appendTicker([], many);
    expect(log).toHaveLength(LOG_LIMIT);
    expect(texts(log)[0]).toBe("e5");
  });
});
