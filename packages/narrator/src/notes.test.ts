import { describe, expect, it } from "vitest";
import { EMPTY_NOTES, NOTES_LIMITS, parseNotes } from "./notes";

describe("parseNotes", () => {
  it("round-trips a notes object through JSON", () => {
    const notes = {
      summary: "s",
      openThreads: ["t"],
      cast: [{ name: "Ines", note: "dock boss" }],
      lastUpdatedTick: 40,
      lastRejections: ["r"],
    };
    expect(parseNotes(JSON.parse(JSON.stringify(notes)))).toEqual(notes);
  });

  it("treats the column default, junk and old strings tolerantly", () => {
    expect(parseNotes({})).toEqual(EMPTY_NOTES);
    expect(parseNotes(null)).toEqual(EMPTY_NOTES);
    expect(parseNotes(42)).toEqual(EMPTY_NOTES);
    expect(parseNotes("")).toEqual(EMPTY_NOTES);
    expect(parseNotes("old summary").summary).toBe("old summary");
  });

  it("bounds sizes", () => {
    const notes = parseNotes({
      summary: "x".repeat(5_000),
      openThreads: Array.from({ length: 20 }, () => "t"),
      cast: [],
      lastUpdatedTick: 1,
    });
    expect(notes.summary.length).toBe(NOTES_LIMITS.summaryChars);
    expect(notes.openThreads).toHaveLength(NOTES_LIMITS.threads);
  });
});
