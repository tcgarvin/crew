import { describe, expect, it } from "vitest";
import { EMPTY_NOTES, NOTES_LIMITS, mergeThreads, parseNotes } from "./notes";

const thread = {
  title: "The assay office",
  scale: "episode" as const,
  people: ["Halla Iyer"],
  stage: "Halla wants her cores delivered upright.",
  nextBeat: "On arrival at the Hub, the lab finds one cracked.",
  lastBeatTick: 30,
  beatCardShown: false,
};

const card = {
  tick: 30,
  decisionId: "decision:1",
  title: "Halla's cores",
  speaker: "Halla Iyer",
  gist: "Halla leans in with a crate.",
  leftLabel: "Take them",
  rightLabel: "Not this run",
  chosen: "left" as const,
};

describe("parseNotes", () => {
  it("round-trips a notes object through JSON", () => {
    const notes = {
      summary: "s",
      threads: [thread],
      cardsShown: [card],
      cast: [{ name: "Ines", note: "dock boss", portId: "port.kessler_drift", lastSeenTick: 30 }],
      lastUpdatedTick: 40,
      lastRejections: ["r"],
    };
    expect(parseNotes(JSON.parse(JSON.stringify(notes)))).toEqual(notes);
  });

  it("reads cast stored before D25 with no port and an unknown sighting", () => {
    const notes = parseNotes({
      summary: "s",
      openThreads: [],
      cast: [{ name: "Ines", note: "dock boss" }],
      lastUpdatedTick: 40,
    });
    expect(notes.cast).toEqual([
      { name: "Ines", note: "dock boss", portId: null, lastSeenTick: -1 },
    ]);
  });

  it("migrates notes stored before D31/D32: openThreads become threads, no card history", () => {
    const notes = parseNotes({
      summary: "s",
      openThreads: ["Who is the stranger?"],
      cast: [],
      lastUpdatedTick: 40,
    });
    expect(notes.threads).toEqual([
      {
        title: "Who is the stranger?",
        scale: "episode",
        people: [],
        stage: "Who is the stranger?",
        nextBeat: "",
        lastBeatTick: null,
        beatCardShown: false,
      },
    ]);
    expect(notes.cardsShown).toEqual([]);
  });

  it("treats the column default, junk and old strings tolerantly", () => {
    expect(parseNotes({})).toEqual(EMPTY_NOTES);
    expect(parseNotes(null)).toEqual(EMPTY_NOTES);
    expect(parseNotes(42)).toEqual(EMPTY_NOTES);
    expect(parseNotes("")).toEqual(EMPTY_NOTES);
    expect(parseNotes("old summary").summary).toBe("old summary");
  });

  it("bounds sizes and keeps the most recent cards", () => {
    const notes = parseNotes({
      summary: "x".repeat(5_000),
      threads: Array.from({ length: 20 }, () => thread),
      cardsShown: Array.from({ length: 20 }, (_, i) => ({ ...card, tick: i })),
      cast: [],
      lastUpdatedTick: 1,
    });
    expect(notes.summary.length).toBe(NOTES_LIMITS.summaryChars);
    expect(notes.threads).toHaveLength(NOTES_LIMITS.threads);
    expect(notes.cardsShown).toHaveLength(NOTES_LIMITS.cardsShown);
    expect(notes.cardsShown[0]?.tick).toBe(20 - NOTES_LIMITS.cardsShown);
    expect(notes.cardsShown.at(-1)?.tick).toBe(19);
  });
});

describe("mergeThreads (D32)", () => {
  const written = [
    {
      title: "The assay office",
      scale: "episode" as const,
      people: ["Halla Iyer"],
      stage: "s",
      nextBeat: "n",
    },
    { title: "Jax's debt", scale: "season" as const, people: ["Jax"], stage: "s", nextBeat: "n" },
    { title: "New thread", scale: "beat" as const, people: ["Priya"], stage: "s", nextBeat: "n" },
  ];

  it("stamps the hook tick on threads whose people were on a card or made an offer", () => {
    const merged = mergeThreads(written, [thread], 90, ["Halla Iyer", "Priya catches you aft."]);
    expect(merged.map((t) => t.lastBeatTick)).toEqual([90, null, 90]);
  });

  it("keeps the previous tick for a thread that stayed quiet", () => {
    const merged = mergeThreads(written, [thread], 90, []);
    expect(merged.map((t) => t.lastBeatTick)).toEqual([30, null, null]);
  });

  it("sets beatCardShown on the thread a beat card foreshadowed and keeps it afterwards (D39)", () => {
    const merged = mergeThreads(written, [thread], 90, [], "jax's debt");
    expect(merged.map((t) => t.beatCardShown)).toEqual([false, true, false]);
    // A beat card is a card: the thread's last beat is now.
    expect(merged[1]?.lastBeatTick).toBe(90);
    const later = mergeThreads(written, merged, 120, []);
    expect(later.map((t) => t.beatCardShown)).toEqual([false, true, false]);
  });

  it("reads a stored thread without the flag as not foreshadowed (pre-D39)", () => {
    const { beatCardShown: _omitted, ...stored } = thread;
    const notes = parseNotes({ summary: "s", threads: [stored], cast: [], lastUpdatedTick: 1 });
    expect(notes.threads[0]?.beatCardShown).toBe(false);
  });
});
