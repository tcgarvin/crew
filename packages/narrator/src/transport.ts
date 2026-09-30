/**
 * The model transport `runNarrator` calls: one structured-output completion. Injected, so the
 * narrator package holds no provider SDK or endpoint and tests never touch the network.
 *
 * W9 decision: OpenRouter transport (owner). The concrete OpenRouter implementation
 * (chat completions + `response_format: json_schema`, strict) is not in this package yet; see the
 * W9 report. Until one is supplied, `runNarrator` answers with the null fallback
 * (`fallback: "notConfigured"`).
 */
import type { NarratorUsage } from "./contract";

export interface ModelRequest {
  readonly model: string;
  /** System content parts in order; the last one is the prompt-cache breakpoint. */
  readonly system: readonly string[];
  readonly user: string;
  readonly schemaName: string;
  /** Closed JSON Schema for the plan (all properties required, no recursion). */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
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
