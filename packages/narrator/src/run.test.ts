import { readFileSync } from "node:fs";
import {
  type CommandId,
  type DecisionId,
  type EventId,
  type MachineId,
  type PortDefId,
  type SaveEnvelope,
  type SimEvent,
  createKernel,
  createRegistry,
} from "@crew/sim";
import { describe, expect, it, vi } from "vitest";
import type { NarratorRequest } from "./contract";
import {
  approachRequest,
  captainAshoreRequest,
  departureGateRequest,
  farCaptainAshoreRequest,
  passengerAboardRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
  stageDockRequest,
} from "./fixtures";
import { EMPTY_NOTES } from "./notes";
import { NULL_NARRATOR_MODEL } from "./null";
import { HOOK_INSTRUCTIONS, STATIC_RULES } from "./prompts/index";
import { PROMPT_VERSION } from "./prompts/system";
import { NARRATOR_TIMEOUT_MS, STAGING_TIMEOUT_MS, runNarrator, runNarratorWithTrace } from "./run";
import { content, emptyPlan, fakeTransport, okResult } from "./test-support";
import { TransportError } from "./transport";

const offer = {
  kind: "offerJob",
  issuerName: "Halla Iyer",
  issuerRole: "assay clerk",
  issuerOrg: "Drift Assay Office",
  pitch: "These cores took three shifts to pull. Keep them upright and the Hub labs will love you.",
  description: "Core samples for the Hub labs. Keep them upright.",
  fromPort: "port.kessler_drift",
  toPort: "port.crossroads_hub",
  cargoItem: "item.crate_fragile",
  quantity: "one",
  payTier: "standard",
  urgency: "relaxed",
  surface: false,
  passenger: false,
  roundTrip: false,
};

const assayThread = {
  title: "The assay office",
  scale: "episode" as const,
  people: ["Halla Iyer"],
  stage: "Halla wants her cores at the Hub upright.",
  nextBeat: "At the Hub, the lab finds one cracked.",
};

const stranger = {
  kind: "surfaceDecision",
  title: "A stranger at the ramp",
  speaker: "Dane Whitcross",
  situation:
    "Dane stands at the top of the ramp, arms folded. “There's a woman down there asking for passage. Says she can pay. Won't say where to.”",
  left: { label: "Bring her up.", effect: "none", coursePort: "", talkWith: "", tone: "" },
  right: { label: "Not this run.", effect: "none", coursePort: "", talkWith: "", tone: "" },
  leftAftermath: "Dane waves her aboard.",
  rightAftermath: "Dane sends her back down the ramp.",
  beatOfThread: "",
  closesThread: "",
};

function event(
  tick: number,
  type: "decisionPending" | "decisionResolved",
  decisionId: string,
  side: "left" | "right" = "left",
): SimEvent {
  const payload = type === "decisionResolved" ? { decisionId, side } : { decisionId };
  return {
    id: `e${tick}` as EventId,
    tick,
    seq: 0,
    type,
    subjectIds: [],
    causeIds: [],
    source: "sim",
    significance: "narrative",
    payload,
  } as unknown as SimEvent;
}

function ctx(transport?: ReturnType<typeof fakeTransport>) {
  return {
    gameId: "g1",
    content: content(),
    callId: "call1",
    ...(transport === undefined ? {} : { transport }),
  };
}

function policyRequest(): NarratorRequest {
  const req = approachRequest(content());
  const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
  const decisionId = "d1" as DecisionId;
  const captain = Object.values(snapshot.state.actors)[0];
  if (captain === undefined) throw new Error("no crew");
  snapshot.state.decisions.records[decisionId] = {
    id: decisionId,
    origin: "policy",
    perspectiveActorId: captain.id,
    prompt: {
      key: "job.offer",
      params: {
        issuer: "Noor Sadler, Hub Co-op",
        name: "Noor Sadler",
        role: "dispatcher",
        org: "Hub Co-op",
        from: "port.crossroads_hub",
        to: "port.kessler_drift",
        cargo: "item.crate_general",
        urgency: "soon",
        pitch: "I've had this manifest on my screen all shift. Take it off my hands?",
      },
    },
    left: {
      label: { key: "job.offer.accept", params: {} },
      commands: [],
      aftermath: { key: "job.accept.aftermath", params: {} },
    },
    right: {
      label: { key: "job.offer.decline", params: {} },
      commands: [],
      aftermath: { key: "job.decline.aftermath", params: {} },
    },
    status: "pending",
    createdTick: req.hook.tick,
  };
  snapshot.state.decisions.queue.push(decisionId);
  const hook = {
    id: req.hook.id,
    kind: "policyDecision" as const,
    context: { decisionId },
    tick: req.hook.tick,
  };
  snapshot.state.narrator.pendingHook = hook;
  return { ...req, hook, snapshot };
}

describe("runNarrator", () => {
  it("translates a valid plan and rewrites the notes", async () => {
    const plan = emptyPlan({
      intents: [offer, { ...offer, fromPort: "port.green_meridian" }] as never,
      notes: { summary: "Arrived at the Drift.", threads: [assayThread], cast: [] },
    });
    const transport = fakeTransport(okResult(JSON.stringify(plan)));
    const req = captainAshoreRequest(content());
    const res = await runNarrator(req, ctx(transport));
    expect(res.fallback).toBeUndefined();
    expect(res.commands.map((c) => c.kind)).toEqual(["offerJob"]);
    expect(res.model).toBe("anthropic/claude-opus-4.6");
    expect(res.promptVersion).toBe(PROMPT_VERSION);
    expect(res.usage?.cacheReadInputTokens).toBe(900);
    expect(res.notesUpdate).toEqual({
      summary: "Arrived at the Drift.",
      // D32: Halla made an offer this call, so her thread's last beat is now.
      threads: [{ ...assayThread, lastBeatTick: req.hook.tick, beatCardShown: false }],
      cardsShown: [],
      // D25: whoever made an offer joins the cast at their port, even if the model forgot them.
      cast: [
        {
          name: "Halla Iyer",
          note: "assay clerk, Drift Assay Office; offered us work",
          portId: "port.kessler_drift",
          lastSeenTick: req.hook.tick,
        },
      ],
      lastUpdatedTick: req.hook.tick,
      lastRejections: [expect.stringContaining("fromPort must be port.kessler_drift")],
    });
    // What the transport was asked for.
    const [call] = transport.calls;
    expect(call?.system).toHaveLength(2);
    expect(call?.user).toContain("## Why you were called");
    expect(call?.user).toContain("captainAshore");
    expect(call?.jsonSchema.additionalProperties).toBe(false);
    expect(call?.jsonSchema).not.toHaveProperty("$schema");
  });

  it("places a passenger in the cast aboard, bound for their port (passengers §4.1)", async () => {
    const passage = {
      ...offer,
      issuerName: "Halla Thorne",
      issuerRole: "assayer",
      issuerOrg: "",
      pitch: "I need to get to Ossory and back.",
      description: "Passage to Ossory and home. She says she has a claim to sell.",
      fromPort: "port.crossroads_hub",
      toPort: "port.ossory_station",
      cargoItem: "",
      passenger: true,
      roundTrip: true,
    };
    const plan = emptyPlan({
      intents: [passage] as never,
      notes: { summary: "A passenger at the Hub.", threads: [], cast: [] },
    });
    const req = farCaptainAshoreRequest(content());
    const res = await runNarrator(req, ctx(fakeTransport(okResult(JSON.stringify(plan)))));
    expect(res.dropped).toEqual([]);
    expect(res.commands.map((c) => c.kind)).toEqual(["offerJob"]);
    expect(res.notesUpdate?.cast).toEqual([
      {
        name: "Halla Thorne",
        note: "assayer; passenger, bound for Ossory Station and back",
        portId: null,
        lastSeenTick: req.hook.tick,
      },
    ]);
  });

  describe("places a passenger in the cast once the kernel has settled their fate", () => {
    const aboardNote = "assayer; passenger, bound for Ossory Station and back";
    const stored = (portId: string | null = null) => ({
      summary: "Halla rides with us.",
      threads: [],
      cast: [{ name: "Halla Thorne", note: aboardNote, portId, lastSeenTick: 2_900 }],
    });

    function endedRequest(
      reason: "leftBehind" | "putOff" | "completed" | "declined",
      opts: { readonly roundTrip?: boolean; readonly ashore?: boolean } = {},
    ): NarratorRequest {
      const req = passengerAboardRequest(content());
      const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
      const job = Object.values(snapshot.state.jobs)[0];
      const passenger = Object.values(snapshot.state.actors).find((a) => a.passenger === true);
      if (job?.passage === undefined || passenger === undefined) throw new Error("fixture");
      job.passage.roundTrip = opts.roundTrip ?? true;
      if (reason === "declined") {
        job.status = "declined";
        delete snapshot.state.actors[passenger.id];
      } else {
        job.passage.endReason = reason;
      }
      if (reason === "completed") delete snapshot.state.actors[passenger.id];
      if (opts.ashore === true) {
        passenger.availability = "offShip";
        passenger.location = {
          kind: "inExternalStore",
          portId: "port.ossory_station" as PortDefId,
          storeKey: "lounge" as never,
        };
      }
      return { ...req, snapshot };
    }

    // The model rewrites the entry with no port, as it was told to while she rode.
    const rewrite = emptyPlan({
      notes: {
        summary: "s",
        threads: [],
        cast: [{ name: "Halla Thorne", note: aboardNote, portId: "" }],
      },
    });

    it.each([
      ["leftBehind", { ashore: true }, "port.ossory_station", "left behind at Ossory Station"],
      ["putOff", { ashore: true }, "port.ossory_station", "put off at Ossory Station"],
      [
        "completed",
        { roundTrip: true },
        "port.crossroads_hub",
        "passage completed, at Crossroads Hub",
      ],
      [
        "completed",
        { roundTrip: false },
        "port.ossory_station",
        "passage completed, at Ossory Station",
      ],
      ["declined", {}, "port.crossroads_hub", "offer declined, still at Crossroads Hub"],
    ] as const)("%s %o → at %s, note says %s", async (reason, opts, portId, phrase) => {
      const res = await runNarrator(endedRequest(reason, opts), {
        ...ctx(fakeTransport(okResult(JSON.stringify(rewrite)))),
        notes: stored(),
      });
      expect(res.notesUpdate?.cast).toEqual([
        {
          name: "Halla Thorne",
          note: `${aboardNote}; ${phrase}`,
          portId,
          lastSeenTick: expect.any(Number),
        },
      ]);
    });

    it("leaves a passenger still aboard, or put off but not yet ashore, without a port", async () => {
      for (const req of [passengerAboardRequest(content()), endedRequest("putOff")]) {
        const res = await runNarrator(req, {
          ...ctx(fakeTransport(okResult(JSON.stringify(rewrite)))),
          notes: stored(),
        });
        expect(res.notesUpdate?.cast[0]).toMatchObject({ note: aboardNote, portId: null });
      }
    });

    it("does not move an entry the model has placed itself, and appends the reason only once", async () => {
      const placed = emptyPlan({
        notes: {
          summary: "s",
          threads: [],
          cast: [
            { name: "Halla Thorne", note: "went home by liner", portId: "port.kessler_drift" },
          ],
        },
      });
      const moved = await runNarrator(endedRequest("leftBehind", { ashore: true }), {
        ...ctx(fakeTransport(okResult(JSON.stringify(placed)))),
        notes: stored(),
      });
      expect(moved.notesUpdate?.cast[0]).toMatchObject({
        note: "went home by liner",
        portId: "port.kessler_drift",
      });
      const again = emptyPlan({
        notes: {
          summary: "s",
          threads: [],
          cast: [
            {
              name: "Halla Thorne",
              note: `${aboardNote}; left behind at Ossory Station`,
              portId: "",
            },
          ],
        },
      });
      const twice = await runNarrator(endedRequest("leftBehind", { ashore: true }), {
        ...ctx(fakeTransport(okResult(JSON.stringify(again)))),
        notes: stored("port.ossory_station"),
      });
      expect(twice.notesUpdate?.cast[0]?.note).toBe(`${aboardNote}; left behind at Ossory Station`);
    });
  });

  it("feeds stored notes back into the prompt", async () => {
    const transport = fakeTransport(okResult(JSON.stringify(emptyPlan())));
    const notes = {
      summary: "They owe the Guild a favour.",
      openThreads: ["The Guild's favour"],
      cast: [],
      lastUpdatedTick: 10,
    };
    await runNarrator(quietTooLongRequest(content()), { ...ctx(transport), notes });
    expect(transport.calls[0]?.user).toContain("summary: They owe the Guild a favour.");
    expect(transport.calls[0]?.user).toContain("- [episode] The Guild's favour (nobody yet)");
  });

  it.each([
    ["no transport", undefined, "notConfigured"],
    ["provider error", new TransportError("apiError", "HTTP 502"), "apiError"],
    ["timeout", new TransportError("timeout", "slow"), "timeout"],
    ["unexpected throw", new Error("socket hang up"), "apiError"],
    ["refusal", { ...okResult(""), content: null, finish: "refusal" as const }, "refusal"],
    ["truncation", { ...okResult("{"), finish: "length" as const }, "truncated"],
    ["non-JSON output", okResult("Sure! Here is a plan."), "schemaInvalid"],
    [
      "schema violation",
      okResult(JSON.stringify({ rationale: "x", intents: [] })),
      "schemaInvalid",
    ],
  ])("falls back to the null narrator on %s", async (_name, result, reason) => {
    const transport = result === undefined ? undefined : fakeTransport(result);
    const res = await runNarrator(quietTooLongRequest(content()), ctx(transport));
    expect(res).toEqual({
      commands: [],
      callId: "call1",
      model: NULL_NARRATOR_MODEL,
      promptVersion: PROMPT_VERSION,
      fallback: reason,
    });
  });

  it("times out a transport that never answers", async () => {
    const hang = Object.assign(
      (request: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
      { calls: [] },
    );
    const res = await runNarrator(quietTooLongRequest(content()), {
      ...ctx(hang as never),
      timeoutMs: 20,
    });
    expect(res.fallback).toBe("timeout");
  });

  it("gives the staging call its own, shorter default timeout (D70)", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const transport = fakeTransport(okResult(JSON.stringify({ rationale: "bare", intents: [] })));
    await runNarrator(stageDockRequest(content()), ctx(transport));
    expect(timeouts).toHaveBeenLastCalledWith(STAGING_TIMEOUT_MS);
    await runNarrator(quietTooLongRequest(content()), ctx(transport));
    expect(timeouts).toHaveBeenLastCalledWith(NARRATOR_TIMEOUT_MS);
    expect(STAGING_TIMEOUT_MS).toBeLessThan(NARRATOR_TIMEOUT_MS);
    timeouts.mockRestore();
  });

  it("answers a policy decision with a template card on the null path", async () => {
    const res = await runNarrator(policyRequest(), ctx());
    expect(res.card).toEqual({
      decisionId: "d1",
      title: "Noor Sadler, Hub Co-op",
      speaker: "Noor Sadler",
      situation:
        "“I've had this manifest on my screen all shift. Take it off my hands?” General freight, Crossroads Hub to Kessler Drift, wanted soon.",
      leftLabel: "Take the job",
      rightLabel: "Pass on it",
      leftAftermath: "Taken. The crew start loading — we leave once the hold is full.",
      rightAftermath: "You pass. Word gets around the board; another offer usually turns up.",
    });
    expect(res.card?.situation).not.toMatch(/\d/);
  });

  it("uses the model's card prose for a policy decision when it passes checks", async () => {
    const card = {
      title: "Hub Co-op wants a runner",
      speaker: "Noor Sadler",
      situation: "A co-op clerk leans in the hatch with a manifest and a tired smile.",
      leftLabel: "Sign it",
      rightLabel: "Not today",
      leftAftermath: "The clerk hands over the manifest and the crew start on it.",
      rightAftermath: "The clerk shrugs and heads back down the ramp.",
    };
    const transport = fakeTransport(okResult(JSON.stringify(emptyPlan({ card }))));
    const res = await runNarrator(policyRequest(), ctx(transport));
    expect(res.card).toEqual({ decisionId: "d1", ...card });
  });

  it("ignores surfaceDecision's beat and closing fields copied onto card, and says so (D67)", async () => {
    const card = {
      title: "Hub Co-op wants a runner",
      speaker: "Noor Sadler",
      situation: "A co-op clerk leans in the hatch with a manifest and a tired smile.",
      leftLabel: "Sign it",
      rightLabel: "Not today",
      leftAftermath: "The clerk hands over the manifest and the crew start on it.",
      rightAftermath: "The clerk shrugs and heads back down the ramp.",
    };
    const plan = { ...emptyPlan(), card: { ...card, beatOfThread: "", closesThread: "" } };
    const res = await runNarrator(
      policyRequest(),
      ctx(fakeTransport(okResult(JSON.stringify(plan)))),
    );
    expect(res.fallback).toBeUndefined();
    expect(res.card).toEqual({ decisionId: "d1", ...card });
    expect(res.notesUpdate?.lastRejections).toContain(
      "card: beatOfThread and closesThread ignored; they belong on surfaceDecision only",
    );
    // Anything else unknown on the card still fails the schema.
    const odd = { ...emptyPlan(), card: { ...card, mood: "tense" } };
    const failed = await runNarrator(
      policyRequest(),
      ctx(fakeTransport(okResult(JSON.stringify(odd)))),
    );
    expect(failed.fallback).toBe("schemaInvalid");
  });
});

describe("policy decisions are narrated (D37)", () => {
  it("dresses a departure-gate card in the engineer's voice, keyed to its decision", async () => {
    const card = {
      title: "Priya on the engine",
      speaker: "Priya Kessler",
      situation:
        "Priya wipes her hands on a rag by the engine hatch. “She'll run, but that bearing's talking to me. Give me a few hours and I'll have it quiet.”",
      leftLabel: "Take your few hours.",
      rightLabel: "We go now.",
      leftAftermath: "Priya gets to work and we leave when she says so.",
      rightAftermath: "Priya seals the hatch and we go as we are.",
    };
    const transport = fakeTransport(okResult(JSON.stringify(emptyPlan({ card }))));
    const req = departureGateRequest(content());
    const res = await runNarrator(req, ctx(transport));
    expect(res.fallback).toBeUndefined();
    expect(res.card).toEqual({ decisionId: "d9", ...card });
    expect(res.card?.speaker).toBe("Priya Kessler");
    expect(res.commands).toEqual([]);

    // The digest tells the model who brings the card and which machine it is about, and does not
    // list the card as already seen.
    const user = transport.calls[0]?.user ?? "";
    expect(user).toContain(
      "policyDecision: decision d9 needs the captain (about Main Engine); Priya Kessler brings it",
    );
    expect(user).toContain(
      'd9 (policy): Before we leave: Main Engine (brought by Priya Kessler): The main engine is running with an unrepaired fault. We can sit here while it\'s fixed, or go as we are. Left: "Hold for repairs". Right: "Leave anyway".',
    );
    expect(user).not.toMatch(/## What the captain has seen[\s\S]*d9/);
    // ...but the history records it with the prose once dressed.
    expect(res.notesUpdate?.cardsShown).toEqual([
      expect.objectContaining({ decisionId: "d9", speaker: "Priya Kessler", title: card.title }),
    ]);
  });

  it("keeps the engineer as the template speaker when the narrator is unavailable", async () => {
    const res = await runNarrator(departureGateRequest(content()), ctx());
    expect(res.fallback).toBe("notConfigured");
    expect(res.card).toMatchObject({ decisionId: "d9", speaker: "Priya Kessler" });
    expect(res.card?.leftLabel).toBe("Hold for repairs");
  });
});

describe("what the captain has seen (D31)", () => {
  it("records a surfaced card and stamps the thread it belongs to", async () => {
    const plan = emptyPlan({
      intents: [stranger] as never,
      notes: {
        summary: "s",
        threads: [{ ...assayThread, title: "The stranger", people: ["Dane Whitcross"] }],
        cast: [],
      },
    });
    const transport = fakeTransport(okResult(JSON.stringify(plan)));
    const req = quietTooLongRequest(content());
    const res = await runNarrator(req, ctx(transport));
    expect(res.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(res.notesUpdate?.cardsShown).toEqual([
      {
        tick: req.hook.tick,
        decisionId: null,
        title: "A stranger at the ramp",
        speaker: "Dane Whitcross",
        // Clipped to 25 words.
        gist: "Dane stands at the top of the ramp, arms folded. “There's a woman down there asking for passage. Says she can pay. Won't say where…",
        leftLabel: "Bring her up.",
        rightLabel: "Not this run.",
        chosen: null,
        closedThread: null,
      },
    ]);
    expect(res.notesUpdate?.threads[0]?.lastBeatTick).toBe(req.hook.tick);
  });

  it("nulls the captain as a speaker, keeps the card and says why next call (D41)", async () => {
    const plan = emptyPlan({
      intents: [{ ...stranger, speaker: "Mara Osei" }] as never,
      notes: { summary: "s", threads: [], cast: [] },
    });
    const transport = fakeTransport(okResult(JSON.stringify(plan)));
    const req = quietTooLongRequest(content());
    const res = await runNarrator(req, ctx(transport));
    expect(res.dropped).toEqual([]);
    expect(res.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(res.notesUpdate?.cardsShown[0]?.speaker).toBeNull();
    expect(res.notesUpdate?.lastRejections).toEqual([
      'speaker: "Mara Osei" is the captain and cannot bring a card; name the crew member who does',
    ]);
    await runNarrator(req, { ...ctx(transport), notes: res.notesUpdate });
    expect(transport.calls.at(-1)?.user).toContain(
      'rejected last time: speaker: "Mara Osei" is the captain and cannot bring a card',
    );
  });

  it("sets beatCardShown on the thread a beat card foreshadows (D39)", async () => {
    const thread = { ...assayThread, title: "The stranger", people: ["Dane Whitcross"] };
    const beat = { ...stranger, beatOfThread: "the stranger" };
    const plan = emptyPlan({
      intents: [beat] as never,
      notes: { summary: "s", threads: [thread], cast: [] },
    });
    const transport = fakeTransport(okResult(JSON.stringify(plan)));
    const req = quietTooLongRequest(content());
    const stored = {
      ...EMPTY_NOTES,
      threads: [{ ...thread, lastBeatTick: null, beatCardShown: false }],
    };
    const res = await runNarrator(req, { ...ctx(transport), notes: stored });
    expect(res.dropped).toEqual([]);
    expect(res.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(res.notesUpdate?.threads).toEqual([
      { ...thread, lastBeatTick: req.hook.tick, beatCardShown: true },
    ]);
    // A second beat card for the same thread is refused next call, with the reason in the notes.
    const again = await runNarrator(req, { ...ctx(transport), notes: res.notesUpdate });
    expect(again.commands).toEqual([]);
    expect(again.notesUpdate?.lastRejections[0]).toMatch(/already had its beat card/);
    expect(again.notesUpdate?.threads[0]?.beatCardShown).toBe(true);
  });

  it("retires the thread a closing card ends and refuses to close it again (D56)", async () => {
    const thread = { ...assayThread, title: "The stranger", people: ["Dane Whitcross"] };
    const closing = { ...stranger, closesThread: "the stranger" };
    // The model keeps writing the thread; the server retires it anyway.
    const plan = emptyPlan({
      intents: [closing] as never,
      notes: { summary: "s", threads: [thread], cast: [] },
    });
    const transport = fakeTransport(okResult(JSON.stringify(plan)));
    const req = quietTooLongRequest(content());
    const stored = {
      ...EMPTY_NOTES,
      threads: [{ ...thread, lastBeatTick: null, beatCardShown: false }],
    };
    const res = await runNarrator(req, { ...ctx(transport), notes: stored });
    expect(res.dropped).toEqual([]);
    expect(res.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(res.notesUpdate?.threads).toEqual([]);
    expect(res.notesUpdate?.cardsShown[0]?.closedThread).toBe("The stranger");
    // Next call: the digest shows the card as closing it, a second closing card is refused, and
    // the thread stays retired even though the model writes it back again.
    const again = await runNarrator(req, { ...ctx(transport), notes: res.notesUpdate });
    expect(transport.calls.at(-1)?.user).toContain('(closed thread "The stranger")');
    expect(again.commands).toEqual([]);
    expect(again.notesUpdate?.lastRejections[0]).toMatch(/matches no open thread/);
    expect(again.notesUpdate?.threads).toEqual([]);
  });

  it("records the policy card prose with the pending decision's id", async () => {
    const card = {
      title: "Hub Co-op wants a runner",
      speaker: "Noor Sadler",
      situation: "A co-op clerk leans in the hatch with a manifest and a tired smile.",
      leftLabel: "Sign it",
      rightLabel: "Not today",
      leftAftermath: "",
      rightAftermath: "",
    };
    const transport = fakeTransport(okResult(JSON.stringify(emptyPlan({ card }))));
    const req = policyRequest();
    const res = await runNarrator(req, ctx(transport));
    expect(res.notesUpdate?.cardsShown).toEqual([
      {
        tick: req.hook.tick,
        decisionId: "d1",
        title: "Hub Co-op wants a runner",
        speaker: "Noor Sadler",
        gist: card.situation,
        leftLabel: "Sign it",
        rightLabel: "Not today",
        chosen: null,
        closedThread: null,
      },
    ]);
  });

  it("marks the side chosen from a resolution event, by id or by title, and shows it", async () => {
    const req = policyRequest();
    const decision = req.snapshot.state.decisions.records["d1" as DecisionId];
    if (decision === undefined) throw new Error("fixture");
    decision.status = "resolved";
    decision.chosen = "right";
    req.snapshot.state.decisions.queue = [];
    const hook = { ...req.hook, kind: "quietTooLong" as const, context: { quietSinceTick: 0 } };
    req.snapshot.state.narrator.pendingHook = hook;
    const notes = {
      summary: "s",
      threads: [],
      cast: [],
      lastUpdatedTick: 10,
      cardsShown: [
        {
          tick: 5,
          decisionId: null,
          title: "Noor Sadler, Hub Co-op",
          speaker: "Noor Sadler",
          gist: "An offer.",
          leftLabel: "Take the job",
          rightLabel: "Pass on it",
          chosen: null,
          closedThread: null,
        },
      ],
    };
    const transport = fakeTransport(okResult(JSON.stringify(emptyPlan())));
    const res = await runNarrator(
      { ...req, hook, recentEvents: [event(8, "decisionResolved", "d1", "right")] },
      { ...ctx(transport), notes },
    );
    expect(res.notesUpdate?.cardsShown).toEqual([
      { ...notes.cardsShown[0], decisionId: "d1", chosen: "right" },
    ]);
    expect(transport.calls[0]?.user).toContain(
      '- t5 "Noor Sadler, Hub Co-op" (Noor Sadler): An offer. → chose "Pass on it"',
    );
  });

  it("fills in a resolution from the snapshot when the event was lost", async () => {
    const req = policyRequest();
    const decision = req.snapshot.state.decisions.records["d1" as DecisionId];
    if (decision === undefined) throw new Error("fixture");
    decision.status = "resolved";
    decision.chosen = "left";
    req.snapshot.state.decisions.queue = [];
    const hook = { ...req.hook, kind: "quietTooLong" as const, context: { quietSinceTick: 0 } };
    req.snapshot.state.narrator.pendingHook = hook;
    const entry = {
      tick: 5,
      speaker: "Noor Sadler",
      gist: "An offer.",
      leftLabel: "Take the job",
      rightLabel: "Pass on it",
      chosen: null,
      closedThread: null,
    };
    const notes = {
      summary: "s",
      threads: [],
      cast: [],
      lastUpdatedTick: 10,
      cardsShown: [
        { ...entry, decisionId: "d1", title: "Hub Co-op wants a runner" },
        { ...entry, decisionId: null, title: "Noor Sadler, Hub Co-op" },
        { ...entry, decisionId: null, title: "Something else" },
      ],
    };
    const transport = fakeTransport(okResult(JSON.stringify(emptyPlan())));
    const res = await runNarrator({ ...req, hook, recentEvents: [] }, { ...ctx(transport), notes });
    expect(res.notesUpdate?.cardsShown.map((c) => [c.decisionId, c.chosen])).toEqual([
      ["d1", "left"],
      // Already claimed by the entry above, so the title match does not double up.
      [null, null],
      [null, null],
    ]);
    const alone = await runNarrator(
      { ...req, hook, recentEvents: [] },
      { ...ctx(transport), notes: { ...notes, cardsShown: notes.cardsShown.slice(1) } },
    );
    expect(alone.notesUpdate?.cardsShown.map((c) => [c.decisionId, c.chosen])).toEqual([
      ["d1", "left"],
      [null, null],
    ]);
  });

  it("records a card the kernel surfaced itself from its pending event", async () => {
    const req = policyRequest();
    const transport = fakeTransport(okResult(JSON.stringify(emptyPlan())));
    const res = await runNarrator(
      { ...req, recentEvents: [event(8, "decisionPending", "d1")] },
      ctx(transport),
    );
    // The model wrote no card, so the template entry from the event stands.
    expect(res.notesUpdate?.cardsShown).toEqual([
      {
        tick: 8,
        decisionId: "d1",
        title: "Noor Sadler, Hub Co-op",
        speaker: "Noor Sadler",
        gist: expect.stringContaining("I've had this manifest"),
        leftLabel: "Take the job",
        rightLabel: "Pass on it",
        chosen: null,
        closedThread: null,
      },
    ]);
  });

  it("keeps only the most recent twelve cards", async () => {
    const plan = emptyPlan({ intents: [stranger] as never });
    const transport = fakeTransport(okResult(JSON.stringify(plan)));
    const req = quietTooLongRequest(content());
    const cardsShown = Array.from({ length: 12 }, (_, i) => ({
      tick: i,
      decisionId: `decision:${i}`,
      title: `Card ${i}`,
      speaker: null,
      gist: "g",
      leftLabel: "l",
      rightLabel: "r",
      chosen: "left" as const,
      closedThread: null,
    }));
    const notes = { summary: "s", threads: [], cast: [], lastUpdatedTick: 11, cardsShown };
    const res = await runNarrator(req, { ...ctx(transport), notes });
    expect(res.notesUpdate?.cardsShown).toHaveLength(12);
    expect(res.notesUpdate?.cardsShown[0]?.title).toBe("Card 1");
    expect(res.notesUpdate?.cardsShown.at(-1)?.title).toBe("A stranger at the ramp");
  });
});

describe("prompt text (D29, D31, D32)", () => {
  it("tells the model cards are spoken by a named person and capped at 70 words", () => {
    expect(STATIC_RULES).toContain("never more than 70");
    expect(STATIC_RULES).toContain("firstOfficer");
    expect(STATIC_RULES).not.toContain("60 words");
  });

  it("tells the model the captain only knows what the cards showed, and keeps threads TV-style", () => {
    expect(STATIC_RULES).toContain('"What the captain has seen" is what they know');
    expect(STATIC_RULES).toContain("variation on a recent one, do nothing");
    expect(STATIC_RULES).toContain("Think like a TV writers' room");
    expect(STATIC_RULES).not.toContain("openThreads");
  });

  it("tells the model to write crew in their voice, share the stage, pick the oldest beat, and foreshadow once (D38, D39)", () => {
    expect(STATIC_RULES).toContain("the voice line is how they sound, every time");
    expect(STATIC_RULES).toContain("A crew member never sounds like another");
    expect(STATIC_RULES).toContain("Share the stage");
    expect(STATIC_RULES).toContain("advance the one with the oldest last beat");
    expect(STATIC_RULES).toContain("unless an episode thread is at its climax");
    expect(STATIC_RULES).toContain("A beat card advances a thread without asking for a decision");
    expect(STATIC_RULES).toContain("at most one beat card before its payoff");
  });

  it("tells the model it is the only source of work when the captain goes ashore (D40, D70), never on arrival (D66)", () => {
    expect(STATIC_RULES).not.toContain("approachingPort");
    expect(STATIC_RULES).not.toContain("stageDock");
    expect(STATIC_RULES).not.toContain("jobBoard:");
    expect(STATIC_RULES).toContain(
      "captainAshore: The captain has walked down the ramp and out onto this dock looking for work",
    );
    expect(HOOK_INSTRUCTIONS.captainAshore).toContain("the card comes up when they meet");
    expect(HOOK_INSTRUCTIONS.captainAshore).toContain("beyond the gate is the port itself");
    expect(STATIC_RULES).toContain("is delivered in person");
    expect(STATIC_RULES).toContain(
      "Work is only offered while the ship is docked: never in flight.",
    );
    expect(STATIC_RULES).toContain("there is no work at this port until the next call");
    expect(STATIC_RULES).toContain("offering nothing must be a deliberate story choice");
    expect(STATIC_RULES).toContain("At most one surfaced card");
    expect(STATIC_RULES).not.toContain("the port board is empty");
  });

  it("tells the model the captain is the player and never speaks on a card (D41)", () => {
    expect(STATIC_RULES).toContain("The captain is the player and never speaks on a card");
    expect(STATIC_RULES).toContain("cards are brought to them");
    expect(STATIC_RULES).toContain("The captain's voice line is how the captain comes across");
    expect(STATIC_RULES).toContain("how others react to or quote the captain");
    expect(PROMPT_VERSION).toBe("v0.23");
  });

  it("tells the model it never decides a passenger's fate or narrates what they did ashore (passengers §4.3, §6)", () => {
    expect(STATIC_RULES).toContain("A passenger is a job with a person in it");
    expect(STATIC_RULES).toContain("You never decide a passenger's fate");
    expect(STATIC_RULES).toContain("You never narrate what they did ashore as fact");
    expect(STATIC_RULES).toContain("The stated purpose of the trip is the description");
    expect(STATIC_RULES).toContain("the truth may differ, and lives in your notes");
    expect(STATIC_RULES).toContain("endPassage on a card side");
    expect(STATIC_RULES).toContain("never as the only side");
    // The six card kinds of §6.
    expect(STATIC_RULES).toContain("the offer (the passenger at the ramp");
    expect(STATIC_RULES).toContain("a waypoint or long-leg beat");
    expect(STATIC_RULES).toContain("crew friction");
    expect(STATIC_RULES).toContain("the turn, on passengerReturned");
    expect(STATIC_RULES).toContain("the overdue card, which the sim raises itself");
    expect(STATIC_RULES).toContain("the payoff on contractCompleted");
    // The overdue card under policyDecision: the first officer speaks, wait / leave.
    expect(STATIC_RULES).toContain(
      "For an overdue passenger (commerce.passengerOverdue) the first officer brings it",
    );
    expect(STATIC_RULES).toContain("the left side waits, the right side leaves without them");
  });

  it("tells the model to end each arc on a closing card that names it (D54, D56)", () => {
    expect(STATIC_RULES).toContain("Arcs end on a card.");
    expect(STATIC_RULES).toContain("Set closesThread to that thread's exact title");
    expect(STATIC_RULES).toContain("A thread is closed once");
    expect(HOOK_INSTRUCTIONS.notableEvent).toContain("this is the moment for its closing card");
  });

  it("tells the model it runs the pace (D46)", () => {
    expect(STATIC_RULES).toContain("Pacing:");
    expect(STATIC_RULES).toContain("You run the pace.");
    expect(STATIC_RULES).toContain("Maintenance is not forward motion.");
    expect(STATIC_RULES).toContain("Do not fill that wait with faults.");
    expect(STATIC_RULES).toContain("A fault is a pressure, not a pastime.");
    expect(HOOK_INSTRUCTIONS.quietTooLong).toContain("Say which you chose and why in rationale");
    // v0.14: one job at a time, so every hook asks for one offer and none with a job in hand.
    for (const text of Object.values(HOOK_INSTRUCTIONS)) expect(text).not.toContain("one or two");
    expect(HOOK_INSTRUCTIONS.captainAshore).toContain("one job from this port");
    expect(HOOK_INSTRUCTIONS.quietTooLong).toContain(
      "captain idle with no job in hand, never in flight",
    );
    expect(HOOK_INSTRUCTIONS.quietTooLong).not.toContain("Prefer advancing a thread");
  });

  it("makes quietTooLong a neutral check-in, not a request for work (D46 as amended)", () => {
    const quiet = HOOK_INSTRUCTIONS.quietTooLong;
    expect(quiet).toContain("This is a check-in, not a request");
    expect(quiet).toContain("read the Pacing rules");
    expect(quiet).toContain("What is available to you");
    expect(quiet).not.toContain("Take the first of these that fits");
    expect(quiet).not.toContain("offer work if the captain is idle");
  });

  it("tells the model parts come only from a port market and it never narrates a repair the digest does not show (D47)", () => {
    expect(STATIC_RULES).toContain("Parts come only from a port's market");
    expect(STATIC_RULES).toContain("the crew buy it themselves, from the ship's money");
    expect(STATIC_RULES).toContain("Your lever is stockMarket");
    expect(STATIC_RULES).toContain("Scarcity is a story");
    expect(STATIC_RULES).toContain(
      "it never states that a repair, delivery, purchase or payment has happened unless the digest shows it",
    );
    expect(STATIC_RULES).toContain("Only use the six levers");
    expect(STATIC_RULES).toContain("surfaceDecision, stockMarket, scheduleHazard");
    expect(STATIC_RULES).not.toContain("five levers");
  });

  it("tells the model about the watch, the empty helm and the hazard lever (D77-D79, v0.21)", () => {
    expect(STATIC_RULES).toContain("The ship keeps watches. The day is three watches");
    expect(STATIC_RULES).toContain("who has the helm (and since when)");
    expect(STATIC_RULES).toContain("You never set moods or thoughts");
    expect(STATIC_RULES).toContain("An empty helm");
    expect(STATIC_RULES).toContain("is the ship's own failing");
    expect(STATIC_RULES).toContain("A hazard is the helm's stakes");
    expect(STATIC_RULES).toContain("never while another fault is unrepaired");
    expect(STATIC_RULES).toContain("you never decide who that is or how it goes");
    expect(HOOK_INSTRUCTIONS.quietTooLong).toContain("scheduleHazard on a long leg");
  });

  it("tells the model about the galley and dirt, and never to invent food (D81-D83, v0.22)", () => {
    expect(STATIC_RULES).toContain("The ship eats from her galley.");
    expect(STATIC_RULES).toContain("these are the crew's story to tell");
    expect(STATIC_RULES).toContain("Provisions run out and are bought at ports like parts");
    expect(STATIC_RULES).toContain("stockMarket may put provisions on sale");
    expect(STATIC_RULES).toContain("Never invent food the sim has not cooked");
    expect(STATIC_RULES).toContain("A filthy room is the ship's own failing");
    expect(HOOK_INSTRUCTIONS.quietTooLong).toContain("a meal can be that beat");
  });

  it("tells the model off-watch life and rivalries are the crew's, and how privateTalk works (D84-D87, v0.23)", () => {
    expect(STATIC_RULES).toContain("The crew have lives off watch.");
    expect(STATIC_RULES).toContain(
      "These are the sim's and the crew's story to tell, never yours to invent",
    );
    expect(STATIC_RULES).toContain(
      "An argument or a rivalry is the kind of thing a card is made of",
    );
    expect(STATIC_RULES).toContain("Write to who people are");
    expect(STATIC_RULES).toContain(
      "effect privateTalk, talkWith their full name, tone warm or stern",
    );
    expect(STATIC_RULES).toContain(
      "how it went shows next call in what they feel about the captain",
    );
    expect(STATIC_RULES).toContain("Only use the six levers");
    expect(HOOK_INSTRUCTIONS.quietTooLong).toContain("so can a rivalry or an argument");
    expect(HOOK_INSTRUCTIONS.notableEvent).toContain("An argument or a rivalry among the crew");
  });
});

describe("the null path hands out work (D40)", () => {
  it("still offers a job at the board after a provider error", async () => {
    const transport = fakeTransport(new TransportError("apiError", "HTTP 502"));
    const res = await runNarrator(captainAshoreRequest(content()), ctx(transport));
    expect(res.fallback).toBe("apiError");
    expect(res.model).toBe(NULL_NARRATOR_MODEL);
    expect(res.commands).toHaveLength(1);
    const command = res.commands[0];
    if (command?.kind !== "offerJob") throw new Error("no offer");
    expect(command.payload.surface).toBe(true);
    expect(command.payload.job.fromPortId).toBe("port.kessler_drift");
  });
});

describe("fixtures and kernel authority (N6)", () => {
  it("fixtures are valid saves the kernel restores", () => {
    const kernel = createKernel(createRegistry());
    for (const req of [
      approachRequest(content()),
      quietTooLongRequest(content()),
      stageDockRequest(content()),
    ]) {
      expect(() => kernel.restore(req.snapshot, content())).not.toThrow();
    }
  });

  it("migrates a stored schema-7 snapshot to 8 with the scenario's watch bill (D77)", () => {
    // A frozen copy of the schema-7 `approach.json`: the fixtures under `fixtures/` are
    // regenerated with the kernel, so they stop being schema 7.
    const stored = JSON.parse(
      readFileSync(new URL("./testdata/schema7-approach.json", import.meta.url), "utf8"),
    ) as NarratorRequest;
    expect(stored.snapshot.schemaVersion).toBe(7);
    const restored = createKernel(createRegistry()).restore(stored.snapshot, content());
    const actors = Object.values(restored.state.actors);
    const captain = actors.find((a) => a.roleTags.includes("captain"));
    expect(captain?.schedule).toEqual({ section: { key: "red", index: 0 } });
    expect(actors.find((a) => a.defId === "crew.dane_whitcross")?.schedule.section?.key).toBe(
      "blue",
    );
    expect(actors.find((a) => a.defId === "crew.bettina_solheim")?.schedule).toEqual({});
    expect(actors.every((a) => a.thoughts.length === 0)).toBe(true);
    expect(restored.state.hazards).toEqual([]);
  });

  it("reads a stored snapshot whose config predates the day units (D76) with the loaded values", async () => {
    // Stored before D76: `commerce.passage.overdueSeconds`, no `overdueDays`. The digest's
    // OVERDUE line needs the window, so a missing key would throw rather than render. The
    // config is put back to its pre-D76 shape by hand, so this holds however the fixtures move.
    const stored = structuredClone(passengerOverdueRequest(content()));
    const passage = stored.snapshot.config.commerce.passage as unknown as Record<string, unknown>;
    passage.overdueSeconds = 150;
    // biome-ignore lint/performance/noDelete: the stored config must lack the key.
    delete passage.overdueDays;
    const run = await runNarratorWithTrace(stored, {
      gameId: stored.gameId,
      content: content(),
      notes: EMPTY_NOTES,
    });
    expect(run.trace.digest).toContain("OVERDUE");
  });

  it("rejects a forbidden kind from the narrator regardless of prompt", () => {
    const req = quietTooLongRequest(content());
    const kernel = createKernel(createRegistry());
    const world = kernel.restore(req.snapshot, content());
    const pump = Object.values(world.state.machines).find(
      (m) => m.defId === "machine.coolant_pump",
    );
    const result = kernel.enqueueCommand(world, {
      id: "cmd:narrator:evil:0" as CommandId,
      source: "narrator",
      kind: "scenarioInjectFault",
      payload: { machineId: pump?.id as MachineId, faultKey: "worn_bearing" },
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.rejection.code).toBe("unauthorized");
  });
});
