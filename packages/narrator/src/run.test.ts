import {
  type CommandId,
  type DecisionId,
  type MachineId,
  type SaveEnvelope,
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
      notes: { summary: "Arrived at the Drift.", openThreads: ["The assay office"], cast: [] },
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
      openThreads: ["The assay office"],
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
      openThreads: [],
      cast: [],
      lastUpdatedTick: 10,
    };
    await runNarrator(quietTooLongRequest(content()), { ...ctx(transport), notes });
    expect(transport.calls[0]?.user).toContain("summary: They owe the Guild a favour.");
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

describe("prompt text (D29)", () => {
  it("tells the model cards are spoken by a named person and capped at 70 words", () => {
    expect(STATIC_RULES).toContain("never more than 70");
    expect(STATIC_RULES).toContain("firstOfficer");
    expect(STATIC_RULES).not.toContain("60 words");
    expect(PROMPT_VERSION).toBe("v0.3");
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
