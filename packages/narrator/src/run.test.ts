import {
  type CommandId,
  type DecisionId,
  type EventId,
  type MachineId,
  type SaveEnvelope,
  type SimEvent,
  createKernel,
  createRegistry,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorRequest } from "./contract";
import { approachingPortRequest, quietTooLongRequest } from "./fixtures";
import { NULL_NARRATOR_MODEL } from "./null";
import { STATIC_RULES } from "./prompts/index";
import { PROMPT_VERSION } from "./prompts/system";
import { runNarrator } from "./run";
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
  speaker: "Mara Osei",
  situation:
    "Mara stands at the top of the ramp, arms folded. “There's a woman down there asking for passage. Says she can pay. Won't say where to.”",
  left: { label: "Bring her up.", effect: "none", coursePort: null },
  right: { label: "Not this run.", effect: "none", coursePort: null },
  leftAftermath: "Mara waves her aboard.",
  rightAftermath: "Mara sends her back down the ramp.",
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
  const req = approachingPortRequest(content());
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
    const req = approachingPortRequest(content());
    const res = await runNarrator(req, ctx(transport));
    expect(res.fallback).toBeUndefined();
    expect(res.commands.map((c) => c.kind)).toEqual(["offerJob"]);
    expect(res.model).toBe("anthropic/claude-opus-4.6");
    expect(res.promptVersion).toBe(PROMPT_VERSION);
    expect(res.usage?.cacheReadInputTokens).toBe(900);
    expect(res.notesUpdate).toEqual({
      summary: "Arrived at the Drift.",
      // D32: Halla made an offer this call, so her thread's last beat is now.
      threads: [{ ...assayThread, lastBeatTick: req.hook.tick }],
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
    expect(call?.user).toContain("approachingPort");
    expect(call?.jsonSchema.additionalProperties).toBe(false);
    expect(call?.jsonSchema).not.toHaveProperty("$schema");
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
});

describe("what the captain has seen (D31)", () => {
  it("records a surfaced card and stamps the thread it belongs to", async () => {
    const plan = emptyPlan({
      intents: [stranger] as never,
      notes: {
        summary: "s",
        threads: [{ ...assayThread, title: "The stranger", people: ["Mara Osei"] }],
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
        speaker: "Mara Osei",
        // Clipped to 25 words.
        gist: "Mara stands at the top of the ramp, arms folded. “There's a woman down there asking for passage. Says she can pay. Won't say where…",
        leftLabel: "Bring her up.",
        rightLabel: "Not this run.",
        chosen: null,
      },
    ]);
    expect(res.notesUpdate?.threads[0]?.lastBeatTick).toBe(req.hook.tick);
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
    expect(PROMPT_VERSION).toBe("v0.4");
  });
});

describe("fixtures and kernel authority (N6)", () => {
  it("fixtures are valid saves the kernel restores", () => {
    const kernel = createKernel(createRegistry());
    for (const req of [approachingPortRequest(content()), quietTooLongRequest(content())]) {
      expect(() => kernel.restore(req.snapshot, content())).not.toThrow();
    }
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
