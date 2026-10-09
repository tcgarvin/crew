import { describe, expect, it } from "vitest";
import { EMPTY_NOTES, NOTES_LIMITS, appendPastArcs, mergeThreads, parseNotes } from "./notes";

const thread = {
  title: "The assay office",
  scale: "episode" as const,
  people: ["Halla Iyer"],
  arcNotes: "Halla wants her cores delivered upright.",
  nextBeat: "On arrival at the Hub, the lab finds one cracked.",
  openedTick: 0,
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
  closedThread: null,
};

describe("parseNotes", () => {
  it("round-trips a notes object through JSON", () => {
    const notes = {
      summary: "s",
      threads: [thread],
      cardsShown: [card],
      pastArcs: [],
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
        arcNotes: "Who is the stranger?",
        nextBeat: "",
        openedTick: 40,
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
      arcNotes: "s",
      nextBeat: "n",
    },
    {
      title: "Jax's debt",
      scale: "season" as const,
      people: ["Jax"],
      arcNotes: "s",
      nextBeat: "n",
    },
    {
      title: "New thread",
      scale: "beat" as const,
      people: ["Priya"],
      arcNotes: "s",
      nextBeat: "n",
    },
  ];

  it("stamps the hook tick on threads whose people were on a card or made an offer", () => {
    const merged = mergeThreads(written, [thread], 90, [
      "Halla Iyer",
      "Priya catches you aft.",
    ]).threads;
    expect(merged.map((t) => t.lastBeatTick)).toEqual([90, null, 90]);
  });

  it("keeps the previous tick for a thread that stayed quiet", () => {
    const merged = mergeThreads(written, [thread], 90, []).threads;
    expect(merged.map((t) => t.lastBeatTick)).toEqual([30, null, null]);
  });

  it("sets beatCardShown on the thread a beat card foreshadowed and keeps it afterwards (D39)", () => {
    const merged = mergeThreads(written, [thread], 90, [], "jax's debt").threads;
    expect(merged.map((t) => t.beatCardShown)).toEqual([false, true, false]);
    // A beat card is a card: the thread's last beat is now.
    expect(merged[1]?.lastBeatTick).toBe(90);
    const later = mergeThreads(written, merged, 120, []).threads;
    expect(later.map((t) => t.beatCardShown)).toEqual([false, true, false]);
  });

  it("reads a stored thread without the flag as not foreshadowed (pre-D39)", () => {
    const { beatCardShown: _omitted, ...stored } = thread;
    const notes = parseNotes({ summary: "s", threads: [stored], cast: [], lastUpdatedTick: 1 });
    expect(notes.threads[0]?.beatCardShown).toBe(false);
  });
});

describe("mergeThreads keeps threads the captain has seen (D101)", () => {
  const write = (title: string) => ({
    title,
    scale: "episode" as const,
    people: ["Nobody Named"],
    arcNotes: "s",
    nextBeat: "n",
  });
  const seen = (title: string, lastBeatTick = 30) => ({ ...thread, title, lastBeatTick });
  const unseen = (title: string) => ({ ...thread, title, openedTick: 0, lastBeatTick: null });

  it("keeps an omitted seen thread unchanged and reports it", () => {
    const old = { ...seen("Jax's debt"), beatCardShown: true };
    const merged = mergeThreads([write("Other")], [old], 90, []);
    expect(merged.threads.map((t) => t.title)).toEqual(["Other", "Jax's debt"]);
    expect(merged.threads[1]).toEqual(old);
    expect(merged.kept).toEqual(["Jax's debt"]);
  });

  it("drops an omitted thread the captain never saw, silently", () => {
    const merged = mergeThreads([write("Other")], [unseen("Quiet one")], 90, []);
    expect(merged.threads.map((t) => t.title)).toEqual(["Other"]);
    expect(merged.kept).toEqual([]);
    expect(merged.retiredWithoutCard).toEqual([]);
  });

  it("lets retired drop a seen thread and reports it; unknown titles are ignored", () => {
    const merged = mergeThreads(
      [],
      [seen("Jax's debt")],
      90,
      [],
      undefined,
      [],
      [" JAX'S DEBT ", "No such thread"],
    );
    expect(merged.threads).toEqual([]);
    expect(merged.kept).toEqual([]);
    expect(merged.retiredWithoutCard).toEqual(["Jax's debt"]);
  });

  it("never keeps a closed thread", () => {
    const merged = mergeThreads([], [seen("Jax's debt")], 90, [], undefined, ["jax's debt"]);
    expect(merged.threads).toEqual([]);
    expect(merged.kept).toEqual([]);
    expect(merged.retiredWithoutCard).toEqual([]);
  });

  it("does not keep a seen thread the model wrote itself", () => {
    const merged = mergeThreads([write("Jax's debt")], [seen("Jax's debt")], 90, []);
    expect(merged.threads).toHaveLength(1);
    expect(merged.kept).toEqual([]);
  });

  it("drops an unseen new thread first when a kept thread would overflow the limit", () => {
    const fresh = Array.from({ length: NOTES_LIMITS.threads }, (_, i) => write(`New ${i}`));
    const merged = mergeThreads(fresh, [seen("Old seen")], 90, []);
    expect(merged.threads).toHaveLength(NOTES_LIMITS.threads);
    expect(merged.threads.map((t) => t.title)).toContain("Old seen");
    expect(merged.droppedForRoom).toEqual([`New ${NOTES_LIMITS.threads - 1}`]);
  });

  it("does not drop for room a thread a beat card just foreshadowed", () => {
    const fresh = Array.from({ length: NOTES_LIMITS.threads }, (_, i) => write(`New ${i}`));
    const last = `New ${NOTES_LIMITS.threads - 1}`;
    const merged = mergeThreads(fresh, [seen("Old seen")], 90, [], last);
    expect(merged.threads.map((t) => t.title)).toContain(last);
    expect(merged.droppedForRoom).toEqual([`New ${NOTES_LIMITS.threads - 2}`]);
  });
});

describe("parseNotes without retired (D101)", () => {
  it("still loads stored notes, which never held a retired list", () => {
    const notes = parseNotes({ summary: "s", threads: [thread], cast: [], lastUpdatedTick: 1 });
    expect(notes.threads).toHaveLength(1);
  });
});

describe("arcs remembered (D103)", () => {
  const write = (title: string) => ({
    title,
    scale: "episode" as const,
    people: ["Halla Iyer"],
    arcNotes: "s",
    nextBeat: "n",
  });

  it("opens a new thread at the hook tick and carries the opening tick after that", () => {
    const first = mergeThreads([write("Fresh")], [], 90, []).threads;
    expect(first[0]?.openedTick).toBe(90);
    const later = mergeThreads([write("Fresh")], first, 200, []).threads;
    expect(later[0]?.openedTick).toBe(90);
  });

  it("returns the threads that ended this call, by closing card or retired", () => {
    const old = { ...thread, title: "Jax's debt", openedTick: 12 };
    const byCard = mergeThreads([write("Jax's debt")], [old], 90, [], undefined, ["jax's debt"]);
    expect(byCard.ended).toEqual([{ thread: old, ending: "closingCard" }]);
    const byRetired = mergeThreads([], [old], 90, [], undefined, [], ["Jax's debt"]);
    expect(byRetired.ended).toEqual([{ thread: old, ending: "retired" }]);
    // Kept (seen, omitted, not retired) and dropped (never seen) threads have not ended.
    const kept = mergeThreads(
      [],
      [old, { ...thread, title: "Unseen", lastBeatTick: null }],
      90,
      [],
    );
    expect(kept.ended).toEqual([]);
  });

  it("appends an ended thread with the summary the model wrote for it", () => {
    const ended = [{ thread: { ...thread, openedTick: 12 }, ending: "closingCard" as const }];
    const written = [
      {
        title: " the ASSAY office ",
        shape: "cargo run, cracked core",
        summary: "One core cracked.",
      },
    ];
    const { pastArcs, missing } = appendPastArcs([], ended, written, 90);
    expect(missing).toEqual([]);
    expect(pastArcs).toEqual([
      {
        title: "The assay office",
        scale: "episode",
        people: ["Halla Iyer"],
        openedTick: 12,
        closedTick: 90,
        ending: "closingCard",
        shape: "cargo run, cracked core",
        summary: "One core cracked.",
      },
    ]);
  });

  it("keeps the arc notes as the summary when the model wrote none, and says so", () => {
    const ended = [{ thread, ending: "retired" as const }];
    const earlier = appendPastArcs([], ended, [], 50).pastArcs;
    const { pastArcs, missing } = appendPastArcs(earlier, ended, [], 90);
    expect(missing).toEqual(["The assay office"]);
    expect(pastArcs).toHaveLength(2);
    expect(pastArcs[1]).toMatchObject({ shape: "", summary: thread.arcNotes, closedTick: 90 });
  });

  it("keeps past arcs to their limit, oldest dropped first", () => {
    const arc = appendPastArcs([], [{ thread, ending: "retired" }], [], 1).pastArcs[0];
    if (arc === undefined) throw new Error("no arc");
    const many = Array.from({ length: NOTES_LIMITS.pastArcs + 3 }, (_, i) => ({
      ...arc,
      closedTick: i,
    }));
    const notes = parseNotes({ ...EMPTY_NOTES, pastArcs: many });
    expect(notes.pastArcs).toHaveLength(NOTES_LIMITS.pastArcs);
    expect(notes.pastArcs[0]?.closedTick).toBe(3);
  });

  it("reads a thread stored before D103: its stage becomes its arc notes", () => {
    const { arcNotes: _a, openedTick: _o, ...rest } = thread;
    const notes = parseNotes({
      summary: "s",
      threads: [{ ...rest, stage: "Halla is waiting." }],
      cast: [],
      lastUpdatedTick: 7,
    });
    expect(notes.threads[0]?.arcNotes).toBe("Halla is waiting.");
    expect(notes.threads[0]?.openedTick).toBe(thread.lastBeatTick);
    expect(notes.pastArcs).toEqual([]);
  });
});
