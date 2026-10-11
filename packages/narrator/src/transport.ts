/**
 * The model transport `runNarrator` calls: one structured-output completion. Injected, so tests
 * never touch the network. The OpenRouter implementation (W9; chat completions, the plan schema
 * in the prompt since D53) is `./openrouter.ts`; without a transport, `runNarrator` answers with
 * the null fallback (`fallback: "notConfigured"`). §notes-turn-tools: a request may offer tools
 * and a result may ask for tool calls; the loop that runs them and calls again is
 * `callForValidReply` (`model-call.ts`), so a transport stays one round trip.
 */
import type { NarratorUsage } from "./contract";

/**
 * §models-and-reasoning-effort: how hard a reasoning model thinks before it answers (OpenRouter's
 * `reasoning.effort`). `default` sends nothing, so the model keeps its own default and a model that
 * does not reason by default (Sonnet) is not switched into extended thinking.
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
 * §notes-turn: the model's reasoning as the provider returned it (OpenRouter's `reasoning_details`;
 * for OpenAI an encrypted blob). Opaque here: it is only ever handed back to the same model.
 */
export type ReasoningDetails = readonly unknown[];

/** §notes-turn-tools: one tool the model may call (OpenAI-style function calling). */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments object. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** §notes-turn-tools: a call the model asked for; `arguments` is its raw JSON text. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * §notes-turn-tools: the tools a request offers. `auto` lets the model call them; `none` still
 * declares them (a conversation that holds tool calls must, for some providers) but asks for an
 * answer.
 */
export type ToolOffer =
  | { readonly kind: "none" }
  | {
      readonly kind: "offered";
      readonly tools: readonly ModelTool[];
      readonly choice: "auto" | "none";
    };

export const NO_TOOLS: ToolOffer = { kind: "none" };

/**
 * §notes-turn: a turn after the first user turn: the model's earlier reply, with its reasoning so
 * the model keeps it, or a further user turn. §notes-turn-tools: a reply that asked for tool calls
 * (`toolRequest`, with its reasoning), and each call's result (`toolResult`).
 */
export type ContinuationMessage =
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly reasoningDetails: ReasoningDetails;
    }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "toolRequest";
      /** Any text the model wrote beside its calls; usually empty. */
      readonly content: string;
      readonly reasoningDetails: ReasoningDetails;
      readonly toolCalls: readonly ToolCall[];
    }
  | { readonly role: "toolResult"; readonly toolCallId: string; readonly content: string };

export interface ModelRequest {
  readonly model: string;
  /** System content parts in order; the last one is the prompt-cache breakpoint. */
  readonly system: readonly string[];
  readonly user: string;
  /** §notes-turn: turns after `user`; empty for a single-turn call. */
  readonly continuation: readonly ContinuationMessage[];
  readonly schemaName: string;
  /** Closed JSON Schema for the plan (all properties required, no recursion). */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly reasoningEffort: ReasoningEffort;
  /** §notes-turn-tools: `NO_TOOLS` for every call but the notes turn. */
  readonly tools: ToolOffer;
  readonly signal: AbortSignal;
}

export type ModelFinish = "stop" | "length" | "refusal" | "toolCalls" | "other";

export interface ModelResult {
  /** The model that actually answered, as the provider reports it. */
  readonly model: string;
  readonly content: string | null;
  readonly finish: ModelFinish;
  readonly refusal?: string;
  readonly usage: NarratorUsage;
  /** §notes-turn: empty when the provider returned none. */
  readonly reasoningDetails: ReasoningDetails;
  /** §notes-turn-tools: the tool calls the model asked for; empty for an answer. */
  readonly toolCalls: readonly ToolCall[];
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

/**
 * §notes-turn-tools: the provider refused a request because it offered tools (the model, or every
 * route OpenRouter has for it, has no function calling). The caller asks again without them.
 */
export class ToolsRejectedError extends TransportError {
  constructor(message: string) {
    super("apiError", message);
    this.name = "ToolsRejectedError";
  }
}

export type ModelTransport = (request: ModelRequest) => Promise<ModelResult>;
