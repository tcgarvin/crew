import type { EventId, SimEvent } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { DIGEST_MAX_CHARS, buildDigest } from "./digest";
import { approachingPortRequest, quietTooLongRequest } from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { content } from "./test-support";

function manyEvents(n: number): SimEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}` as EventId,
    tick: i,
    seq: 0,
    type: "faultRepaired",
    subjectIds: [],
    causeIds: [],
    source: "sim",
    significance: "narrative",
    payload: { machineId: "m3", faultKey: `fault_${i}` },
  })) as unknown as SimEvent[];
}

describe("buildDigest", () => {
  it("is deterministic", () => {
    const req = quietTooLongRequest(content());
    const a = buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook);
    const b = buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook);
    expect(a).toEqual(b);
  });

  it("labels faults nobody has noticed and skips trace events", () => {
    const req = quietTooLongRequest(content());
    const { text } = buildDigest(req.snapshot, req.recentEvents, EMPTY_NOTES, content(), req.hook);
    expect(text).toContain('worn_bearing "Worn bearing" [undiscovered]');
    expect(text).not.toContain("Fault occurred");
    expect(text).toContain("quietTooLong");
  });

  it("stays within the default budget with a long event history", () => {
    const req = approachingPortRequest(content());
    const digest = buildDigest(req.snapshot, manyEvents(500), EMPTY_NOTES, content(), req.hook);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest.approxTokens).toBeLessThanOrEqual(2_500);
  });

  it("truncates deterministically, lowest priority first, and says so", () => {
    const req = quietTooLongRequest(content());
    const small = buildDigest(
      req.snapshot,
      manyEvents(20),
      EMPTY_NOTES,
      content(),
      req.hook,
      1_500,
    );
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBeLessThanOrEqual(1_700);
    expect(small.text).toMatch(/\[digest truncated: \d+ lower-priority lines omitted/);
    // Never-drop sections survive.
    expect(small.text).toContain("## Why you were called");
    expect(small.text).toContain("## Your budget");
    expect(
      buildDigest(req.snapshot, manyEvents(20), EMPTY_NOTES, content(), req.hook, 1_500),
    ).toEqual(small);
  });

  it("includes the running notes, threads and past rejections (D32)", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...EMPTY_NOTES,
      summary: "The pump has been grumbling.",
      threads: [
        {
          title: "A buyer at Meridian",
          scale: "season" as const,
          people: ["Ysolde Maren", "Jax"],
          stage: "Ysolde hinted she has a buyer",
          nextBeat: "When we next dock at Meridian, she names a price",
          lastBeatTick: 1200,
        },
      ],
      lastRejections: ["offerJob: no route"],
    };
    const { text } = buildDigest(req.snapshot, [], notes, content(), req.hook);
    expect(text).toContain("summary: The pump has been grumbling.");
    expect(text).toContain(
      "- [season] A buyer at Meridian (Ysolde Maren, Jax): Ysolde hinted she has a buyer. Next: When we next dock at Meridian, she names a price. Last beat t1200",
    );
    expect(text).toContain("rejected last time: offerJob: no route");
  });

  it("lists what the captain has seen, newest first, right after the notes (D31)", () => {
    const req = quietTooLongRequest(content());
    const base = {
      decisionId: null,
      speaker: null,
      leftLabel: "Take it",
      rightLabel: "Leave it",
      chosen: null,
    };
    const notes = {
      ...EMPTY_NOTES,
      summary: "s",
      cardsShown: [
        {
          ...base,
          tick: 10,
          title: "Resupply",
          gist: "Mara wants more seals.",
          chosen: "right" as const,
        },
        {
          ...base,
          tick: 20,
          decisionId: "decision:2",
          title: "A stranger",
          speaker: "Mara Osei",
          gist: "Someone at the ramp.",
        },
      ],
    };
    const { text } = buildDigest(req.snapshot, [], notes, content(), req.hook);
    const section = text.split("## What the captain has seen\n")[1]?.split("\n\n")[0];
    expect(section).toBe(
      [
        '- t20 "A stranger" (Mara Osei): Someone at the ramp. → unresolved',
        '- t10 "Resupply" (observed): Mara wants more seals. → chose "Leave it"',
      ].join("\n"),
    );
    expect(text.indexOf("## Your notes so far")).toBeLessThan(
      text.indexOf("## What the captain has seen"),
    );
  });

  it("trims the crew and events before what the captain has seen", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...EMPTY_NOTES,
      cardsShown: Array.from({ length: 12 }, (_, i) => ({
        tick: i,
        decisionId: null,
        title: `Card ${i}`,
        speaker: null,
        gist: "g",
        leftLabel: "l",
        rightLabel: "r",
        chosen: null,
      })),
    };
    const small = buildDigest(req.snapshot, manyEvents(20), notes, content(), req.hook, 1_500);
    expect(small.truncated).toBe(true);
    expect(small.text).toContain('- t11 "Card 11"');
    expect(small.text).toContain('- t0 "Card 0"');
    expect(small.text).not.toContain("## Crew");
    expect(small.text).not.toContain("## Recent events");
  });

  it("lists the people the captain knows at the port, without pay (D24, D25)", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...EMPTY_NOTES,
      cast: [
        {
          name: "Ysolde Maren",
          note: "grower, owes us a favour",
          portId: "port.green_meridian",
          lastSeenTick: 1200,
        },
        {
          name: "Hamid Rask",
          note: "Hub dispatcher",
          portId: "port.crossroads_hub",
          lastSeenTick: 3,
        },
      ],
    };
    const { text } = buildDigest(req.snapshot, req.recentEvents, notes, content(), req.hook);
    const section = text.split("## People you know here (Green Meridian)\n")[1]?.split("\n\n")[0];
    expect(section).toBe("- Ysolde Maren: grower, owes us a favour; last seen at tick 1200");
    expect(text).toContain("from Tobiah Rask (freight broker, Meridian Trading House)");
    expect(text).not.toContain("pays");
  });
});
