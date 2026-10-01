/**
 * Shared helpers for this package's tests (imported only by `*.test.ts`).
 */
import { loadBundle } from "@crew/content";
import type { ContentBundle } from "@crew/sim";
import type { NarratorPlan } from "./contract";
import type { ModelResult, ModelTransport } from "./transport";

let bundle: ContentBundle | undefined;

export function content(): ContentBundle {
  if (bundle === undefined) {
    const result = loadBundle();
    if (!result.ok) throw new Error("content failed validation");
    bundle = result.bundle;
  }
  return bundle;
}

export function emptyPlan(overrides: Partial<NarratorPlan> = {}): NarratorPlan {
  return {
    rationale: "test",
    intents: [],
    card: null,
    notes: { summary: "so far", threads: [], cast: [] },
    ...overrides,
  };
}

export function okResult(content: string): ModelResult {
  return {
    model: "anthropic/claude-opus-4.6",
    content,
    finish: "stop",
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    },
  };
}

/** A transport that answers with `result` and records what it was asked. */
export function fakeTransport(result: ModelResult | Error): ModelTransport & {
  readonly calls: Parameters<ModelTransport>[0][];
} {
  const calls: Parameters<ModelTransport>[0][] = [];
  const transport = async (request: Parameters<ModelTransport>[0]) => {
    calls.push(request);
    if (result instanceof Error) throw result;
    return result;
  };
  return Object.assign(transport, { calls });
}
