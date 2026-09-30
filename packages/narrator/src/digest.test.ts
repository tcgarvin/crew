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

  it("includes the running notes and past rejections", () => {
    const req = quietTooLongRequest(content());
    const notes = {
      ...EMPTY_NOTES,
      summary: "The pump has been grumbling.",
      openThreads: ["A buyer at Meridian"],
      lastRejections: ["offerJob: no route"],
    };
    const { text } = buildDigest(req.snapshot, [], notes, content(), req.hook);
    expect(text).toContain("summary: The pump has been grumbling.");
    expect(text).toContain("open thread: A buyer at Meridian");
    expect(text).toContain("rejected last time: offerJob: no route");
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
