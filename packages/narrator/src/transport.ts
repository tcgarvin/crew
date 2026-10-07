/**
 * The model transport `runNarrator` calls: one structured-output completion. Injected, so tests
 * never touch the network. The OpenRouter implementation (W9; chat completions, the plan schema
 * in the prompt since D53) is `./openrouter.ts`; without a transport, `runNarrator` answers with
 * the null fallback (`fallback: "notConfigured"`).
 */
import type { NarratorUsage } from "./contract";

/**
 * D96: how hard a reasoning model thinks before it answers (OpenRouter's `reasoning.effort`).
 * `default` sends nothing, so the model keeps its own default and a model that does not reason
 * by default (Sonnet) is not switched into extended thinking.
 */
export const REASONING_EFFORTS = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * D97: the model's reasoning as the provider returned it (OpenRouter's `reasoning_details`; for
 * OpenAI an encrypted blob). Opaque here: it is only ever handed back to the same model.
 */
export type ReasoningDetails = readonly unknown[];

/**
 * D97: a turn after the first user turn: the model's earlier reply, with its reasoning so the
 * model keeps it, or a further user turn.
 */
export type ContinuationMessage =
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly reasoningDetails: ReasoningDetails;
    }
  | { readonly role: "user"; readonly content: string };

export interface ModelRequest {
  readonly model: string;
  /** System content parts in order; the last one is the prompt-cache breakpoint. */
  readonly system: readonly string[];
  readonly user: string;
  /** D97: turns after `user`; empty for a single-turn call. */
  readonly continuation: readonly ContinuationMessage[];
  readonly schemaName: string;
  /** Closed JSON Schema for the plan (all properties required, no recursion). */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly reasoningEffort: ReasoningEffort;
  readonly signal: AbortSignal;
}

export type ModelFinish = "stop" | "length" | "refusal" | "other";

export interface ModelResult {
  /** The model that actually answered, as the provider reports it. */
  readonly model: string;
  readonly content: string | null;
  readonly finish: ModelFinish;
  readonly refusal?: string;
  readonly usage: NarratorUsage;
  /** D97: empty when the provider returned none. */
  readonly reasoningDetails: ReasoningDetails;
}

/** Transports throw this for provider errors (non-2xx, malformed body, network, timeout). */
export class TransportError extends Error {
  constructor(
    readonly kind: "apiError" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export type ModelTransport = (request: ModelRequest) => Promise<ModelResult>;
