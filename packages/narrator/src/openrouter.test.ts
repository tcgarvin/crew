/**
 * Prompt caching through OpenRouter: the system prefix up to the last breakpoint must be byte
 * identical between calls for the same game, whatever the tick, digest, notes or hook, or the
 * provider never reads the cache (the first live call showed zero cache reads).
 */
import type { CommandId, SaveEnvelope } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorRequest } from "./contract";
import { buildNarratorPlanSchema } from "./contract";
import { approachRequest } from "./fixtures";
import { openRouterTransport, schemaInstruction, systemContentParts } from "./openrouter";
import { planJsonSchema } from "./plan";
import { STATIC_RULES } from "./prompts/index";
import { runNarrator } from "./run";
import { content, emptyPlan } from "./test-support";

interface SentBody {
  readonly messages: readonly [
    { readonly role: "system"; readonly content: readonly Record<string, unknown>[] },
    { readonly role: "user"; readonly content: string },
  ];
}

/** An OpenRouter stand-in that records request bodies and answers with an empty plan. */
function recordingFetch() {
  const bodies: SentBody[] = [];
  const fake = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as SentBody);
    const reply = {
      model: "openai/gpt-6-luna",
      choices: [{ message: { content: JSON.stringify(emptyPlan()) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { bodies, fetch: fake as unknown as typeof fetch };
}

/** The same game later on: docked, time moved on, a fault scheduled, different notes and hook. */
function laterInTheSameGame(req: NarratorRequest): NarratorRequest {
  const travel = req.snapshot.state.travel;
  if (travel.stage === "docked") throw new Error("expected an approach fixture");
  const portId = travel.toPortId;
  const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
  const state = snapshot.state;
  state.tick += 2_400;
  state.travel = { stage: "docked", portId };
  const machine = Object.values(state.machines).find((m) => m.defId === "machine.engine");
  if (machine === undefined) throw new Error("fixture has no engine");
  machine.scheduledFaults.push({
    faultKey: "failed_controller",
    fireAtTick: state.tick + 400,
    causeCommandId: "cmd:narrator:earlier:0" as CommandId,
  });
  state.narrator.budget.faultsRemaining -= 1;
  const hook = {
    id: req.hook.id,
    kind: "captainAshore" as const,
    context: { portId },
    tick: state.tick,
  } as NarratorRequest["hook"];
  state.narrator.pendingHook = hook as never;
  return { ...req, hook, snapshot: { ...snapshot, savedAtTick: state.tick } };
}

describe("OpenRouter prompt caching", () => {
  it("two calls for the same game share the system prefix byte for byte", async () => {
    const { bodies, fetch } = recordingFetch();
    const transport = openRouterTransport({ apiKey: "test", fetch });
    const first = approachRequest(content());
    const second = laterInTheSameGame(first);
    const notes = {
      summary: "They owe the Guild a favour.",
      threads: [],
      cardsShown: [],
      cast: [],
      lastUpdatedTick: first.hook.tick,
    };
    await runNarrator(first, { gameId: "g1", content: content(), transport });
    await runNarrator(second, { gameId: "g1", content: content(), transport, notes });

    const [a, b] = bodies;
    if (a === undefined || b === undefined) throw new Error("expected two requests");
    const systemA = a.messages[0].content;
    const systemB = b.messages[0].content;
    // Everything up to and including the last breakpoint is identical.
    const lastBreakpoint = systemA.map((p) => "cache_control" in p).lastIndexOf(true);
    expect(lastBreakpoint).toBe(systemA.length - 1);
    expect(JSON.stringify(systemB)).toBe(JSON.stringify(systemA));
    // The volatile part really did change, and lives after the breakpoint.
    expect(b.messages[1].content).not.toBe(a.messages[1].content);
    expect(b.messages[1].content).toContain(`tick ${second.hook.tick}`);
    expect(JSON.stringify(systemA)).not.toContain(`tick ${first.hook.tick}`);
    expect(JSON.stringify(systemA)).not.toContain("failed_controller due in");
  });

  it("puts the game-independent rules first, then the game's capability list", async () => {
    const { bodies, fetch } = recordingFetch();
    await runNarrator(approachRequest(content()), {
      gameId: "g1",
      content: content(),
      transport: openRouterTransport({ apiKey: "test", fetch }),
    });
    const system = bodies[0]?.messages[0].content ?? [];
    expect(system[0]).toEqual({
      type: "text",
      text: STATIC_RULES,
      cache_control: { type: "ephemeral" },
    });
    // Machine instance IDs (per game) appear only in the second block.
    expect(String(system[1]?.text)).toMatch(/machine m\d+ "/);
    expect(STATIC_RULES).not.toMatch(/machine m\d+ "/);
  });

  it("never marks more than four breakpoints, always including the last block", () => {
    const parts = systemContentParts(["a", "b", "c", "d", "e", "f"]);
    const marked = parts.map((p) => "cache_control" in p);
    expect(marked).toEqual([false, false, true, true, true, true]);
    expect(systemContentParts(["only"])).toEqual([
      { type: "text", text: "only", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("OpenRouter plan schema (D53)", () => {
  it("sends the schema as the last cached system block, not as a response_format grammar", async () => {
    const { bodies, fetch } = recordingFetch();
    await runNarrator(approachRequest(content()), {
      gameId: "g1",
      content: content(),
      transport: openRouterTransport({ apiKey: "test", fetch }),
    });
    const body = bodies[0];
    if (body === undefined) throw new Error("expected a request");
    expect(body).not.toHaveProperty("response_format");
    const system = body.messages[0].content;
    expect(system.at(-1)).toEqual({
      type: "text",
      text: schemaInstruction(planJsonSchema(buildNarratorPlanSchema())),
      cache_control: { type: "ephemeral" },
    });
  });
});

describe("OpenRouter reasoning effort (§models-and-reasoning-effort)", () => {
  it("sends the default model's effort when none is given (D102: luna at low)", async () => {
    const { bodies, fetch } = recordingFetch();
    await runNarrator(approachRequest(content()), {
      gameId: "g1",
      content: content(),
      transport: openRouterTransport({ apiKey: "test", fetch }),
    });
    expect(bodies[0]).toMatchObject({ reasoning: { effort: "low" } });
  });

  it("sends no reasoning field for effort default, so a model that does not reason keeps not reasoning", async () => {
    const { bodies, fetch } = recordingFetch();
    await runNarrator(approachRequest(content()), {
      gameId: "g1",
      content: content(),
      transport: openRouterTransport({ apiKey: "test", fetch }),
      reasoningEffort: "default",
    });
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });

  it("sends the configured effort as reasoning.effort", async () => {
    const { bodies, fetch } = recordingFetch();
    await runNarrator(approachRequest(content()), {
      gameId: "g1",
      content: content(),
      transport: openRouterTransport({ apiKey: "test", fetch }),
      reasoningEffort: "low",
    });
    expect(bodies[0]).toHaveProperty("reasoning", { effort: "low" });
  });
});

describe("OpenRouter continuation (§notes-turn)", () => {
  const base = {
    model: "openai/gpt-6-luna",
    system: ["rules"],
    user: "the ship",
    schemaName: "narrator_plan",
    jsonSchema: { type: "object" },
    maxTokens: 100,
    signal: new AbortController().signal,
  };
  const reasoningDetails = [{ type: "reasoning.encrypted", data: "opaque" }];

  function replyingFetch(details: readonly unknown[] | undefined) {
    const bodies: Record<string, unknown>[] = [];
    const fake = async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const message = {
        content: "{}",
        ...(details === undefined ? {} : { reasoning_details: details }),
      };
      return new Response(
        JSON.stringify({ model: base.model, choices: [{ message, finish_reason: "stop" }] }),
        { status: 200 },
      );
    };
    return { bodies, fetch: fake as unknown as typeof fetch };
  }

  it("returns the reply's reasoning_details, or none", async () => {
    const withDetails = replyingFetch(reasoningDetails);
    const transport = openRouterTransport({ apiKey: "k", fetch: withDetails.fetch });
    const request = { ...base, continuation: [], reasoningEffort: "low" as const };
    expect((await transport(request)).reasoningDetails).toEqual(reasoningDetails);
    const without = openRouterTransport({ apiKey: "k", fetch: replyingFetch(undefined).fetch });
    expect((await without(request)).reasoningDetails).toEqual([]);
  });

  it("hands the earlier reply back with its reasoning and asks the model to read it", async () => {
    const { bodies, fetch } = replyingFetch(undefined);
    await openRouterTransport({ apiKey: "k", fetch })({
      ...base,
      reasoningEffort: "low",
      continuation: [
        { role: "assistant", content: "the plan", reasoningDetails },
        { role: "user", content: "now your notes" },
      ],
    });
    expect((bodies[0]?.messages as unknown[]).slice(1)).toEqual([
      { role: "user", content: "the ship" },
      { role: "assistant", content: "the plan", reasoning_details: reasoningDetails },
      { role: "user", content: "now your notes" },
    ]);
    expect(bodies[0]?.reasoning).toEqual({ effort: "low", context: "all_turns" });
  });

  it("sends no reasoning field at the default effort, even when handing reasoning back", async () => {
    const { bodies, fetch } = replyingFetch(undefined);
    await openRouterTransport({ apiKey: "k", fetch })({
      ...base,
      reasoningEffort: "default",
      continuation: [
        { role: "assistant", content: "the plan", reasoningDetails },
        { role: "user", content: "now your notes" },
      ],
    });
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });
});
