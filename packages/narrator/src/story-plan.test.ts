/**
 * §the-plan: the plan in the notes: stored plans validated at the boundary, `mergePlan`'s honest
 * bookkeeping (kept landed beats, kept tiers, revisions, set-aside beats, closing cards, endings
 * and stalls), fire-time stamping from the kernel's events, and "Your plan" in the digest.
 */
import type { CommandId, EventId, SaveEnvelope, SimEvent } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import { captainAshoreRequest, quietTooLongRequest, stageDockRequest } from "./fixtures";
import {
  type ArcSketch,
  EMPTY_NOTES,
  EMPTY_PLAN,
  NOTES_LIMITS,
  type PlannedBeat,
  type StoryPlan,
  parseNotes,
} from "./notes";
import { STATIC_RULES } from "./prompts/index";
import {
  type BeatAttribution,
  KEEP_PLAN,
  type WrittenBeat,
  type WrittenPlan,
  type WrittenSketch,
  mergePlan,
  stampFiredBeats,
} from "./story-plan";
import { content, emptyPlan, fakeTransport, okResult, runBothTurns } from "./test-support";

const TICK = 500;

function written(
  name: string,
  tension: WrittenBeat["tension"] = "rising",
  thread = "",
): WrittenBeat {
  return { name, what: `${name}, as planned.`, tension, thread, decided: false };
}

function writtenSketch(premise: string, beats: WrittenBeat[], revised = ""): WrittenSketch {
  return { premise, beats, until: "", tempo: "steady", revised };
}

function stored(beat: WrittenBeat, over: Partial<PlannedBeat> = {}): PlannedBeat {
  return { ...beat, status: "planned", landedTick: null, inMotion: [], ...over };
}

function storedSketch(premise: string, beats: PlannedBeat[], over: Partial<ArcSketch> = {}) {
  return {
    premise,
    beats,
    until: "",
    tempo: "steady" as const,
    revised: "",
    revisions: 0,
    previousPremise: "",
    openedTick: 100,
    ...over,
  };
}

function planOf(over: Partial<StoryPlan>): StoryPlan {
  return { ...EMPTY_PLAN, ...over };
}

function merge(
  previous: StoryPlan,
  plan: Partial<WrittenPlan> = {},
  extra: {
    attributions?: BeatAttribution[];
    closedThread?: string;
    offerMade?: boolean;
  } = {},
) {
  return mergePlan({
    written: { ...KEEP_PLAN, ...plan },
    previous,
    tick: TICK,
    attributions: extra.attributions ?? [],
    closedThread: extra.closedThread,
    offerMade: extra.offerMade ?? false,
  });
}

const EPISODE = storedSketch("Ysolde's sealed crates to the Hub.", [
  stored(written("Ysolde's offer", "setup")),
  stored(written("The pump goes", "rising")),
  stored(written("The crates are not crates", "turn", "Ysolde's crates")),
]);

describe("parseNotes and the plan (§the-plan)", () => {
  it("loads notes stored before the plan with an explicit empty plan", () => {
    const notes = parseNotes({ summary: "s", cast: [], lastUpdatedTick: 10 });
    expect(notes.plan).toEqual(EMPTY_PLAN);
    expect(notes.plan.season.premise).toBe("");
    expect(notes.plan.episode.openedTick).toBe(-1);
  });

  it("round-trips a stored plan and bounds its beats and premise", () => {
    const long = "x".repeat(400);
    const beats = Array.from({ length: 8 }, (_, i) => stored(written(`Beat ${i}`)));
    const plan = planOf({ episode: storedSketch(long, beats) });
    const notes = parseNotes(JSON.parse(JSON.stringify({ ...EMPTY_NOTES, plan })));
    expect(notes.plan.episode.beats).toHaveLength(NOTES_LIMITS.planBeats);
    expect(notes.plan.episode.premise.length).toBe(NOTES_LIMITS.premiseChars);
  });

  it("refuses a stored plan with a status that does not exist (the notes start empty)", () => {
    const bad = planOf({
      episode: storedSketch("p", [{ ...stored(written("b")), status: "maybe" as never }]),
    });
    expect(parseNotes({ ...EMPTY_NOTES, plan: bad })).toEqual(EMPTY_NOTES);
  });
});

describe("mergePlan (§the-plan)", () => {
  it("writes a first sketch with its opening tick and no revisions", () => {
    const { plan, corrections } = merge(EMPTY_PLAN, {
      season: writtenSketch("Can the ship stay hers?", [written("The debt", "setup")]),
    });
    expect(plan.season).toMatchObject({ premise: "Can the ship stay hers?", openedTick: TICK });
    expect(plan.season.revisions).toBe(0);
    expect(plan.season.beats[0]).toMatchObject({ status: "planned", landedTick: null });
    expect(corrections).toEqual([]);
  });

  it("keeps a tier whole when the model leaves its premise empty", () => {
    const previous = planOf({ episode: EPISODE });
    const { plan } = merge(previous);
    expect(plan.episode).toEqual(EPISODE);
  });

  it("keeps a landed beat the model left out, and says so", () => {
    const landed = {
      ...EPISODE,
      beats: [
        stored(written("Ysolde's offer", "setup"), { status: "landed", landedTick: 200 }),
        ...EPISODE.beats.slice(1),
      ],
    };
    const { plan, corrections } = merge(planOf({ episode: landed }), {
      episode: writtenSketch(EPISODE.premise, [
        written("The pump goes"),
        written("The crates are not crates", "turn", "Ysolde's crates"),
      ]),
    });
    expect(plan.episode.beats.map((b) => [b.name, b.status, b.landedTick])).toEqual([
      ["Ysolde's offer", "landed", 200],
      ["The pump goes", "planned", null],
      ["The crates are not crates", "planned", null],
    ]);
    expect(corrections).toEqual([
      expect.stringContaining('kept beat "Ysolde\'s offer" of your episode: it has landed'),
    ]);
  });

  it("carries a landed beat's status by name when the model rewrites its words", () => {
    const landed = {
      ...EPISODE,
      beats: [stored(written("Ysolde's offer", "setup"), { status: "landed", landedTick: 200 })],
    };
    const { plan } = merge(planOf({ episode: landed }), {
      episode: writtenSketch(EPISODE.premise, [
        { ...written("ysolde's OFFER", "setup"), what: "new words" },
      ]),
    });
    expect(plan.episode.beats[0]).toMatchObject({
      status: "landed",
      landedTick: 200,
      what: "new words",
    });
  });

  it("counts a new premise as a revision, and the old premise rides one call as was", () => {
    const previous = planOf({ arc: storedSketch("Ysolde's people want the ship.", []) });
    const first = merge(previous, {
      arc: writtenSketch("Ysolde's people want Jax.", [], "the captain refused the ramp"),
    });
    expect(first.plan.arc).toMatchObject({
      revisions: 1,
      previousPremise: "Ysolde's people want the ship.",
      revised: "the captain refused the ramp",
      openedTick: 100,
    });
    const text = buildDigest(
      quietTooLongRequest(content()).snapshot,
      [],
      { ...EMPTY_NOTES, plan: first.plan },
      content(),
    ).text;
    expect(text).toContain("(was: Ysolde's people want the ship.)");
    const second = merge(first.plan);
    expect(second.plan.arc.previousPremise).toBe("");
    expect(second.plan.arc.revisions).toBe(1);
  });

  it("does not count the same premise rewritten as a revision", () => {
    const previous = planOf({ arc: storedSketch("Ysolde's people want the ship.", []) });
    const { plan } = merge(previous, {
      arc: writtenSketch(" ysolde's people want the ship. ", []),
    });
    expect(plan.arc.revisions).toBe(0);
  });

  it("sets aside a planned beat the model dropped: changed when it said why, skipped when not; gone the call after", () => {
    const changed = merge(planOf({ episode: EPISODE }), {
      episode: writtenSketch(
        EPISODE.premise,
        [written("Ysolde's offer", "setup"), written("The pump goes")],
        "the captain kept Jax aboard",
      ),
    });
    expect(changed.plan.episode.beats.map((b) => [b.name, b.status])).toEqual([
      ["Ysolde's offer", "planned"],
      ["The pump goes", "planned"],
      ["The crates are not crates", "changed"],
    ]);
    const skipped = merge(planOf({ episode: EPISODE }), {
      episode: writtenSketch(EPISODE.premise, [written("Ysolde's offer", "setup")]),
    });
    expect(skipped.plan.episode.beats.map((b) => b.status)).toEqual([
      "planned",
      "skipped",
      "skipped",
    ]);
    expect(merge(skipped.plan).plan.episode.beats.map((b) => b.name)).toEqual(["Ysolde's offer"]);
  });

  it("marks the still-planned beats of a thread a closing card ended as changed", () => {
    const { plan } = merge(planOf({ episode: EPISODE }), {}, { closedThread: "ysolde's crates" });
    expect(plan.episode.beats.map((b) => b.status)).toEqual(["planned", "planned", "changed"]);
    expect(plan.episode.beats[2]?.landedTick).toBe(TICK);
  });

  it("lands a card's or an offer's beat at the hook tick, and puts a lever's in motion", () => {
    const { plan, corrections } = merge(
      planOf({ episode: EPISODE }),
      {},
      {
        attributions: [
          { beat: "Ysolde's offer", kind: "offerJob", commandId: "cmd:narrator:c:0", lands: "now" },
          {
            beat: "the pump goes",
            kind: "scheduleFault",
            commandId: "cmd:narrator:c:1",
            lands: "onFire",
          },
        ],
      },
    );
    expect(plan.episode.beats[0]).toMatchObject({ status: "landed", landedTick: TICK });
    expect(plan.episode.beats[1]).toMatchObject({
      status: "planned",
      inMotion: [{ commandId: "cmd:narrator:c:1", kind: "scheduleFault", sinceTick: TICK }],
    });
    expect(corrections).toEqual([]);
  });

  it("reports a beat name the plan does not have, and attributes nothing", () => {
    const { plan, corrections } = merge(
      planOf({ episode: EPISODE }),
      {},
      {
        attributions: [
          { beat: "Jax dies", kind: "strike", commandId: "cmd:narrator:c:0", lands: "onFire" },
        ],
      },
    );
    expect(plan.episode).toEqual(EPISODE);
    expect(corrections).toEqual([
      'beat "Jax dies" on your strike is not a beat of your episode plan: nothing was attributed; copy a name from "Your plan"',
    ]);
  });

  it("matches a beat the notes turn writes this call, and lands an opening offer's setup", () => {
    const { plan, corrections } = merge(
      EMPTY_PLAN,
      {
        episode: writtenSketch("Ysolde's crates.", [
          written("Ysolde's offer", "setup"),
          written("The pump goes"),
        ]),
      },
      {
        attributions: [
          {
            beat: "The pump goes",
            kind: "scheduleFault",
            commandId: "cmd:narrator:c:1",
            lands: "onFire",
          },
        ],
        offerMade: true,
      },
    );
    expect(corrections).toEqual([]);
    expect(plan.episode.beats[1]?.inMotion).toHaveLength(1);
    // A lever already in motion is in the record, so the offer's setup is not stamped for it.
    expect(plan.episode.beats[0]?.status).toBe("planned");
    const opened = merge(
      EMPTY_PLAN,
      {
        episode: writtenSketch("Ysolde's crates.", [written("Ysolde's offer", "setup")]),
      },
      { offerMade: true },
    );
    expect(opened.plan.episode.beats[0]).toMatchObject({ status: "landed", landedTick: TICK });
  });

  it("stamps an arc beat the model reports landed, and corrects an episode beat named there", () => {
    const arc = storedSketch("Ysolde's people.", [stored(written("The crates run"))]);
    const { plan, corrections } = merge(
      planOf({ arc, episode: EPISODE, episodesSinceArcBeat: 2 }),
      { landed: ["The crates run", "The pump goes"] },
    );
    expect(plan.arc.beats[0]).toMatchObject({ status: "landed", landedTick: TICK });
    expect(plan.episodesSinceArcBeat).toBe(0);
    expect(corrections).toEqual([
      expect.stringContaining('landed "The pump goes": an episode beat lands when'),
    ]);
  });

  it("ends a season: it and its arc become past arcs, the episode goes with them, and the tiers start empty", () => {
    const season = storedSketch(
      "Can the ship stay hers?",
      [
        stored(written("The debt", "setup"), { status: "landed", landedTick: 150 }),
        stored(written("The sale", "peak")),
      ],
      { tempo: "slowBurn", openedTick: 50 },
    );
    const arc = storedSketch("Ysolde's people.", [], { openedTick: 120 });
    const { plan, ended } = merge(planOf({ season, arc, episode: EPISODE }), { ended: ["season"] });
    expect(plan.season).toEqual(EMPTY_PLAN.season);
    expect(plan.arc).toEqual(EMPTY_PLAN.arc);
    expect(plan.episode).toEqual(EMPTY_PLAN.episode);
    expect(ended).toEqual([
      {
        title: "Can the ship stay hers?",
        scale: "season",
        people: [],
        openedTick: 50,
        closedTick: TICK,
        ending: "planEnded",
        shape: "slowBurn season",
        summary: "Can the ship stay hers? Beats: The debt (landed); The sale (never landed).",
      },
      expect.objectContaining({ title: "Ysolde's people.", scale: "arc", openedTick: 120 }),
    ]);
  });

  it("starts the next sketch fresh when a tier ends and its successor is written in the same reply", () => {
    const { plan } = merge(planOf({ episode: { ...EPISODE, revisions: 3 } }), {
      ended: ["episode"],
      episode: writtenSketch("The Hub run home.", [written("A passenger", "setup")]),
    });
    expect(plan.episode).toMatchObject({
      premise: "The Hub run home.",
      revisions: 0,
      openedTick: TICK,
    });
  });

  it("counts episodes that end without an arc beat, and says so in the digest at three", () => {
    const arc = storedSketch("Ysolde's people.", [stored(written("The crates run"))]);
    let plan = planOf({ arc, episode: EPISODE, episodesSinceArcBeat: 2 });
    plan = merge(plan, { ended: ["episode"] }).plan;
    expect(plan.episodesSinceArcBeat).toBe(3);
    const text = buildDigest(
      quietTooLongRequest(content()).snapshot,
      [],
      { ...EMPTY_NOTES, plan },
      content(),
    ).text;
    expect(text).toContain("No arc beat has landed in the last 3 episodes.");
    // An episode that lands an arc beat as it ends does not count.
    const moved = merge(planOf({ arc, episode: EPISODE, episodesSinceArcBeat: 2 }), {
      ended: ["episode"],
      landed: ["The crates run"],
    });
    expect(moved.plan.episodesSinceArcBeat).toBe(0);
  });
});

describe("stampFiredBeats (§beat-attribution)", () => {
  const snapshot = (): SaveEnvelope => structuredClone(quietTooLongRequest(content()).snapshot);
  const inMotion = (kind: string, n: number) => ({
    commandId: `cmd:narrator:c1:${n}`,
    kind,
    sinceTick: 300,
  });
  const motionPlan = (...motions: ReturnType<typeof inMotion>[]) =>
    planOf({
      episode: storedSketch("p", [stored(written("Jax takes a fall"), { inMotion: motions })]),
    });
  const event = (type: string, commandId: string, tick: number): SimEvent =>
    ({
      id: `e${tick}` as EventId,
      tick,
      type,
      significance: "notable",
      subjectIds: [],
      causeIds: [commandId as CommandId],
      source: "narrator",
      payload: {},
    }) as unknown as SimEvent;

  it("lands a beat at the tick of the event its lever caused", () => {
    const { plan, corrections } = stampFiredBeats(
      motionPlan(inMotion("strike", 0)),
      [
        event("commandApplied", "cmd:narrator:c1:0", 301),
        event("struck", "cmd:narrator:c1:0", 301),
      ],
      snapshot().state,
    );
    expect(plan.episode.beats[0]).toMatchObject({
      status: "landed",
      landedTick: 301,
      inMotion: [],
    });
    expect(corrections).toEqual([]);
  });

  it("puts a beat whose lever the kernel refused back to planned, with a line saying why", () => {
    const { plan, corrections } = stampFiredBeats(
      motionPlan(inMotion("strike", 0)),
      [event("commandRejected", "cmd:narrator:c1:0", 301)],
      snapshot().state,
    );
    expect(plan.episode.beats[0]).toMatchObject({
      status: "planned",
      landedTick: null,
      inMotion: [],
    });
    expect(corrections).toEqual([
      'beat "Jax takes a fall": your strike for it did not land (the sim refused it); the beat is planned again',
    ]);
  });

  it("keeps a scheduled fault in motion while it waits, and reverts one that left no trace", () => {
    const snap = snapshot();
    const machine = Object.values(snap.state.machines)[0];
    if (machine === undefined) throw new Error("no machine");
    machine.scheduledFaults.push({
      faultKey: "worn_bearing" as never,
      fireAtTick: 9_000,
      causeCommandId: "cmd:narrator:c1:0" as CommandId,
    });
    const waiting = stampFiredBeats(motionPlan(inMotion("scheduleFault", 0)), [], snap.state);
    expect(waiting.plan.episode.beats[0]?.inMotion).toHaveLength(1);
    expect(waiting.corrections).toEqual([]);
    const gone = stampFiredBeats(motionPlan(inMotion("scheduleHazard", 1)), [], snap.state);
    expect(gone.plan.episode.beats[0]?.inMotion).toEqual([]);
    expect(gone.corrections).toEqual([expect.stringContaining("(it never fired)")]);
  });
});

describe("Your plan in the digest (§your-plan-in-the-digest)", () => {
  const digestOf = (plan: StoryPlan, staging = false) => {
    const req = staging ? stageDockRequest(content()) : quietTooLongRequest(content());
    return buildDigest(req.snapshot, [], { ...EMPTY_NOTES, plan }, content(), req.hook).text;
  };

  it("shows each tier with its beats, their records and ticks, then the beat the episode is at", () => {
    const episode = {
      ...EPISODE,
      tempo: "headlong" as const,
      beats: [
        stored(written("Ysolde's offer", "setup"), { status: "landed", landedTick: 200 }),
        stored(
          { ...written("The pump goes"), decided: true },
          {
            inMotion: [{ commandId: "cmd:narrator:c:1", kind: "scheduleFault", sinceTick: 200 }],
          },
        ),
        stored(written("The crates are not crates", "turn", "Ysolde's crates")),
      ],
    };
    const text = digestOf(
      planOf({
        season: storedSketch("Can the ship stay hers?", [], {
          until: "The loan is paid.",
          tempo: "slowBurn",
        }),
        episode,
      }),
    );
    const section = text.slice(text.indexOf("## Your plan"), text.indexOf("## Open threads"));
    expect(section).toContain(
      "Season (tempo slowBurn, since t100, never revised): Can the ship stay hers? Until: The loan is paid.",
    );
    expect(section).toContain("Arc: none sketched.");
    expect(section).toContain(
      "[setup] \"Ysolde's offer\": Ysolde's offer, as planned. → landed t200",
    );
    expect(section).toContain(
      '[rising, decided] "The pump goes": The pump goes, as planned. → planned (in motion: scheduleFault since t200)',
    );
    expect(section).toContain('[turn, thread "Ysolde\'s crates"] "The crates are not crates"');
    expect(section).toContain('You are at rising (tempo: headlong): "The pump goes".');
    expect(text.indexOf("## Your notes so far")).toBeLessThan(text.indexOf("## Your plan"));
  });

  it("says nothing is sketched with no plan, and is not shown to the staging call", () => {
    expect(digestOf(EMPTY_PLAN)).toContain("## Your plan\n(nothing sketched yet)");
    expect(digestOf(planOf({ episode: EPISODE }), true)).not.toContain("## Your plan");
  });

  it("is never trimmed to fit the budget", () => {
    const req = quietTooLongRequest(content());
    const text = buildDigest(
      req.snapshot,
      [],
      { ...EMPTY_NOTES, plan: planOf({ episode: EPISODE }) },
      content(),
      req.hook,
      1_500,
    ).text;
    expect(text).toContain('You are at setup (tempo: steady): "Ysolde\'s offer".');
  });
});

describe("the notes turn asks for the plan at its moments (§seasons-and-stalls, §notes-turn)", () => {
  const SEASON = storedSketch("Can the ship stay hers?", [], { openedTick: 40 });
  const ARC = storedSketch("Ysolde's people want the ship.", [], { openedTick: 60 });

  async function callWith(notesPlan: StoryPlan, writtenPlan: WrittenPlan = KEEP_PLAN) {
    const req = captainAshoreRequest(content());
    const transport = fakeTransport(
      okResult(
        JSON.stringify(
          emptyPlan({
            notes: {
              summary: "s",
              threads: [],
              cast: [],
              retired: [],
              endedArcs: [],
              plan: writtenPlan,
            },
          }),
        ),
      ),
    );
    const response = await runBothTurns(req, {
      gameId: "g",
      content: content(),
      transport,
      notes: { ...EMPTY_NOTES, plan: notesPlan },
    });
    const notesCall = transport.calls[1];
    const request = notesCall?.continuation[notesCall.continuation.length - 1]?.content ?? "";
    return { response, request };
  }

  it("asks for a season and an arc when none stands, and for the episode when the captain is ashore with none live", async () => {
    const { request } = await callWith(EMPTY_PLAN);
    expect(request).toContain("No season stands: sketch one in plan.season");
    expect(request).toContain("No episode is live and the captain is looking for work");
    const withSeason = await callWith(planOf({ season: SEASON }));
    expect(withSeason.request).not.toContain("No season stands");
    expect(withSeason.request).toContain("No arc stands");
  });

  it("at an episode's opening asks for a different kind of story and points any sketch at the craft rules (v0.40)", async () => {
    const { request } = await callWith(planOf({ season: SEASON, arc: ARC }));
    expect(request).toContain('Read "Past arcs" and your cast first');
    expect(request).toContain("a different kind of story from the last ones");
    expect(request).not.toContain("leave it empty if neither opens one");
    expect(request).toContain('as "Pitch the plan" and "Decide some beats" under "Your notes" say');
    expect(STATIC_RULES).toContain("- Pitch the plan as a writers' room would");
    expect(STATIC_RULES).toContain("- Decide some beats and leave some open.");
  });

  it("asks for nothing more of a plan that stands with a live episode", async () => {
    const { request } = await callWith(planOf({ season: SEASON, arc: ARC, episode: EPISODE }));
    expect(request).not.toContain("No season stands");
    expect(request).not.toContain("No episode is live");
    expect(request).not.toContain("Pitch the plan");
  });

  it("keeps an ended season and its arc as past arcs, then asks for the next season", async () => {
    const { response } = await callWith(planOf({ season: SEASON, arc: ARC, episode: EPISODE }), {
      ...KEEP_PLAN,
      ended: ["season"],
    });
    const notes = response.notesUpdate;
    expect(notes?.pastArcs.map((a) => [a.scale, a.title, a.ending])).toEqual([
      ["season", "Can the ship stay hers?", "planEnded"],
      ["arc", "Ysolde's people want the ship.", "planEnded"],
    ]);
    expect(notes?.plan.season.premise).toBe("");
    const next = await callWith(notes?.plan ?? EMPTY_PLAN);
    expect(next.request).toContain("No season stands");
  });
});
