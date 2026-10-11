/**
 * §notes-turn-tools: each read-only tool answers in compact text from the snapshot, the notes and
 * the request's events; an unknown name or a bad argument is an answer saying so, never a throw.
 */
import { describe, expect, it } from "vitest";
import { captainAshoreRequest, notableEventRequest } from "./fixtures";
import { MAX_TOOL_RESULT_CHARS } from "./model-call";
import { EMPTY_NOTES, EMPTY_PLAN, type NarratorNotes, type PastArc } from "./notes";
import { NOTES_TOOLS, type NotesToolData, runNotesTool } from "./notes-tools";
import { content } from "./test-support";

function arc(title: string, scale: PastArc["scale"], closedTick: number): PastArc {
  return {
    title,
    scale,
    people: ["Ilse Brandt"],
    openedTick: closedTick - 100,
    closedTick,
    ending: "closingCard",
    shape: "cargo run, no trouble",
    summary: `How "${title}" went.`,
  };
}

const NOTES: NarratorNotes = {
  ...EMPTY_NOTES,
  summary: "A slow start at the Drift.",
  threads: [
    {
      title: "Greta's queue",
      scale: "episode",
      people: ["Greta Lindholm", "Ilse Brandt"],
      arcNotes: "Greta thinks the ship jumped her queue.",
      nextBeat: "Next time at the Drift, Greta makes them wait.",
      openedTick: 500,
      lastBeatTick: 600,
      beatCardShown: true,
    },
  ],
  pastArcs: [arc("The ore run", "episode", 400), arc("The long quiet", "season", 450)],
  cast: [
    {
      name: "Ilse Brandt",
      note: "ore buyer at the Drift; owes the captain a favour",
      portId: "port.kessler_drift",
      lastSeenTick: 600,
    },
  ],
  cardsShown: [
    {
      tick: 610,
      decisionId: "d1",
      title: "Ilse's favour",
      speaker: "Ilse Brandt",
      gist: "Ilse offers to skip the queue.",
      leftLabel: "Take it",
      rightLabel: "Wait",
      chosen: "left",
      closedThread: null,
    },
  ],
  plan: {
    ...EMPTY_PLAN,
    episode: {
      ...EMPTY_PLAN.episode,
      premise: "Greta's grudge comes due.",
      beats: [
        {
          name: "Greta makes them wait",
          what: "the queue holds the ship a day",
          tension: "rising",
          thread: "Greta's queue",
          decided: false,
          status: "planned",
          landedTick: null,
          inMotion: [],
        },
      ],
    },
  },
};

function data(overrides: Partial<NotesToolData> = {}): NotesToolData {
  const req = captainAshoreRequest(content());
  return {
    snapshot: req.snapshot,
    notes: NOTES,
    recentEvents: req.recentEvents,
    content: content(),
    ...overrides,
  };
}

const call = (name: string, args: unknown, d: NotesToolData = data()) =>
  runNotesTool(d, name, JSON.stringify(args));

describe("notes-turn tools (§notes-turn-tools)", () => {
  it("offers the seven read-only tools, each with an object schema", () => {
    expect(NOTES_TOOLS.map((t) => t.name)).toEqual([
      "pastArcs",
      "thread",
      "castMember",
      "site",
      "cardsShown",
      "crew",
      "eventsSince",
    ]);
    for (const tool of NOTES_TOOLS) expect(tool.parameters).toMatchObject({ type: "object" });
  });

  it("pastArcs lists ended stories newest first, or one scale, and says when there are none", () => {
    const all = call("pastArcs", {});
    expect(all.indexOf("The long quiet")).toBeLessThan(all.indexOf("The ore run"));
    expect(call("pastArcs", { scale: "season" })).not.toContain("The ore run");
    expect(call("pastArcs", { scale: "series" })).toBe(
      "No past arcs at scale series: 2 have ended this game in all.",
    );
    expect(call("pastArcs", { scale: "saga" })).toMatch(/^Bad arguments for pastArcs: scale/);
  });

  it("pastArcs stays within its budget on a long game and says how many it left out", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...arc(`Story ${i}`, "episode", 1_000 + i),
      summary: "x".repeat(400),
    }));
    const text = call("pastArcs", {}, data({ notes: { ...NOTES, pastArcs: many } }));
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(text).toContain("Story 39");
    expect(text).toMatch(/\(\d+ older not shown: ask by scale\)$/);
  });

  it("thread gives an open thread in full with the plan beats that name it", () => {
    const text = call("thread", { title: "greta's QUEUE" });
    expect(text).toContain('Open thread "Greta\'s queue" [episode]');
    expect(text).toContain("foreshadowed");
    expect(text).toContain("Greta thinks the ship jumped her queue.");
    expect(text).toContain('episode beat "Greta makes them wait"');
  });

  it("thread finds an ended thread among the past arcs, and names the open ones when unknown", () => {
    expect(call("thread", { title: "The ore run" })).toContain('"The ore run" has ended:');
    expect(call("thread", { title: "Nobody's story" })).toBe(
      'No such thread "Nobody\'s story". Open threads: "Greta\'s queue". Ended ones are under pastArcs.',
    );
  });

  it("castMember gathers a cast entry, a port local, threads, past arcs and cards", () => {
    const ilse = call("castMember", { name: "ilse brandt" });
    expect(ilse).toContain("In your cast: Ilse Brandt, at Kessler Drift, last seen t600");
    expect(ilse).toContain(`In open threads: "Greta's queue".`);
    expect(ilse).toContain('In past arcs: "The ore run", "The long quiet".');
    expect(ilse).toContain(`Spoke on cards: "Ilse's favour".`);
    expect(call("castMember", { name: "Greta Lindholm" })).toContain("A local at Kessler Drift");
  });

  it("castMember finds a site's default people and sends a crew name to crew", () => {
    expect(call("castMember", { name: "Teodor Lusk" })).toContain("At the site Harrow End");
    const req = captainAshoreRequest(content());
    const crewName = Object.values(req.snapshot.state.actors).find((a) => a.crew)?.name ?? "";
    expect(call("castMember", { name: crewName })).toContain("one of the ship's company");
  });

  it("castMember says who is in the cast when the name is unknown", () => {
    expect(call("castMember", { name: "Zed Nobody" })).toBe(
      'No such person "Zed Nobody" in your cast, the ports\' locals, the sites or the job issuers. Your cast: "Ilse Brandt".',
    );
  });

  it("site describes a port by id or name, with its locals, your cast and its posts", () => {
    const drift = call("site", { id: "port.kessler_drift" });
    expect(drift).toContain("Kessler Drift (port.kessler_drift)");
    expect(drift).toContain("Locals:");
    expect(drift).toContain("- Ilse Brandt: ore buyer");
    expect(drift).toContain("Posts:");
    // The ship is docked at the Drift in this fixture: what is there now follows.
    expect(drift).toContain("Now (On the dock");
    expect(call("site", { id: "harrow end" })).toContain("a landing site near");
    expect(call("site", { id: "harrow end" })).toContain("Its people when nobody stages it:");
  });

  it("site names the ids when the port is unknown", () => {
    const text = call("site", { id: "port.atlantis" });
    expect(text).toMatch(/^No such port or site "port.atlantis". Ids: .*port.kessler_drift/);
  });

  it("cardsShown gives the last n cards, and says what the history holds when n is more", () => {
    expect(call("cardsShown", { n: 1 })).toContain(`"Ilse's favour" (Ilse Brandt)`);
    expect(call("cardsShown", { n: 30 })).toMatch(/keeps the last 12 cards and holds 1/);
    expect(call("cardsShown", { n: 0 })).toMatch(/^Bad arguments for cardsShown: n/);
    expect(call("cardsShown", { n: 3 }, data({ notes: EMPTY_NOTES }))).toBe(
      "The captain has seen no cards yet.",
    );
  });

  it("crew gives one crew member's full digest line by full or first name", () => {
    const req = captainAshoreRequest(content());
    const actor = Object.values(req.snapshot.state.actors).find(
      (a) => a.crew && a.passenger !== true,
    );
    const name = actor?.name ?? "";
    const line = call("crew", { name });
    expect(line.startsWith(`- ${name}`)).toBe(true);
    expect(line).toContain("good at:");
    expect(call("crew", { name: name.split(" ")[0] })).toBe(line);
  });

  it("crew names who is aboard when the name is unknown", () => {
    expect(call("crew", { name: "Zed Nobody" })).toMatch(
      /^No such crew member or passenger "Zed Nobody". Aboard: /,
    );
  });

  it("eventsSince lists the events since a tick, by type, and says what the request holds", () => {
    const req = notableEventRequest(content());
    const d = data({ snapshot: req.snapshot, recentEvents: req.recentEvents });
    const drift = call("eventsSince", { tick: 0, type: "driftingChanged" }, d);
    expect(drift).toMatch(/^The request holds \d+ events/);
    expect(drift).toContain("- t4100");
    expect(call("eventsSince", { tick: 9_999 }, d)).toMatch(/^No events since t9999\./);
    expect(call("eventsSince", { tick: 0, type: "dragonSighted" }, d)).toMatch(
      /^No events of type dragonSighted since t0\. .* Types held: .*driftingChanged/,
    );
    expect(call("eventsSince", { tick: -1 }, d)).toMatch(/^Bad arguments for eventsSince: tick/);
  });

  it('takes an optional argument written as "" as left out, as models often write it', () => {
    expect(call("pastArcs", { scale: "" })).toBe(call("pastArcs", {}));
    const req = notableEventRequest(content());
    const d = data({ snapshot: req.snapshot, recentEvents: req.recentEvents });
    expect(call("eventsSince", { tick: 0, type: "" }, d)).toBe(call("eventsSince", { tick: 0 }, d));
  });

  it("eventsSince says so when the request holds no events", () => {
    expect(call("eventsSince", { tick: 0 }, data({ recentEvents: [] }))).toBe(
      "No events are held: the request carries only events since the last story call.",
    );
  });

  it("answers an unknown tool, non-JSON arguments and stray arguments without throwing", () => {
    expect(runNotesTool(data(), "launchMissiles", "{}")).toMatch(
      /^No such tool "launchMissiles". Tools: pastArcs, thread/,
    );
    expect(runNotesTool(data(), "thread", "{title:")).toMatch(
      /^Bad arguments for thread: not JSON/,
    );
    expect(call("thread", { title: "x", extra: 1 })).toMatch(/^Bad arguments for thread/);
    expect(runNotesTool(data(), "pastArcs", "")).toContain("2 past arcs");
  });
});
