import { schemaInstruction } from "./plan";
/**
 * OpenRouter implementation of `ModelTransport` (D15).
 *
 * One OpenAI-compatible chat completion. D53: the plan schema rides in the prompt as the last
 * system block (`schemaInstruction`), not as `response_format: json_schema`: strict structured
 * output compiles the schema into a grammar whose provider-side size cap the plan outgrew three
 * times (D45, D47, passengers), and OpenRouter sends a json_schema to Anthropic as a grammar even
 * with `strict: false`. `runNarrator` validates the reply against the zod schema either way. The
 * system parts are sent as separate text content parts with Anthropic-style `cache_control`
 * (`systemContentParts`); OpenRouter forwards that to providers that support prompt caching and
 * ignores it elsewhere. `fetch` is injectable so tests never touch the network.
 *
 * Caching caveats (2026-09-30): a prefix below the model's minimum cacheable length is silently
 * not cached (Anthropic: 1024 tokens for Sonnet 4.6, 4096 for Opus 4.6), and a cache lives with
 * one upstream provider, so a call routed to a different provider starts cold.
 */
import {
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  TransportError,
} from "./transport";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  /** Sent as HTTP-Referer / X-Title so the app shows up in OpenRouter's dashboard. */
  readonly appUrl?: string;
  readonly appTitle?: string;
}

interface CompletionBody {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly refusal?: string | null;
      readonly reasoning_details?: readonly unknown[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    readonly cache_creation_input_tokens?: number;
  };
  readonly error?: {
    readonly message?: string;
    readonly code?: number | string;
    /** OpenRouter wraps the upstream provider's own error text here. */
    readonly metadata?: { readonly raw?: unknown; readonly provider_name?: string };
  };
}

/** Anthropic allows at most four cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * The system message's content parts. Every system block is static (see `prompts/index.ts`), so
 * each carries a breakpoint, up to the provider's limit counted back from the last block: the
 * last static block always has one (the whole static prefix is cached), and an earlier block
 * that is shared more widely (the rules, identical across games) gets its own so a new game still
 * reads it from cache. Nothing volatile may ever be passed in `system`.
 */
export function systemContentParts(system: readonly string[]) {
  const firstMarked = Math.max(0, system.length - MAX_CACHE_BREAKPOINTS);
  return system.map((text, i) =>
    i >= firstMarked
      ? { type: "text" as const, text, cache_control: { type: "ephemeral" as const } }
      : { type: "text" as const, text },
  );
}

/**
 * D97: the turns after the first user turn. An earlier reply goes back with its
 * `reasoning_details`, so a reasoning model continues from its own reasoning rather than
 * re-deriving it.
 */
function continuationMessages(request: ModelRequest) {
  return request.continuation.map((message) =>
    message.role === "assistant"
      ? {
          role: "assistant" as const,
          content: message.content,
          ...(message.reasoningDetails.length === 0
            ? {}
            : { reasoning_details: message.reasoningDetails }),
        }
      : message,
  );
}

/**
 * OpenRouter's `reasoning` object: absent at the default effort. D97: with reasoning handed back,
 * `context: "all_turns"` asks an OpenAI model to read it (its default may drop earlier turns'
 * reasoning); other providers ignore the field.
 */
function reasoningField(request: ModelRequest) {
  if (request.reasoningEffort === "default") return {};
  const handedBack = request.continuation.some(
    (m) => m.role === "assistant" && m.reasoningDetails.length > 0,
  );
  return {
    reasoning: {
      effort: request.reasoningEffort,
      ...(handedBack ? { context: "all_turns" } : {}),
    },
  };
}

export { schemaInstruction } from "./plan";

export function openRouterTransport(options: OpenRouterOptions): ModelTransport {
  const doFetch = options.fetch ?? fetch;
  return async (request: ModelRequest): Promise<ModelResult> => {
    const systemParts = systemContentParts([
      ...request.system,
      schemaInstruction(request.jsonSchema),
    ]);
    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: [
        { role: "system", content: systemParts },
        { role: "user", content: request.user },
        ...continuationMessages(request),
      ],
      ...reasoningField(request),
    };

    let response: Response;
    try {
      response = await doFetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": options.appUrl ?? "https://crew.vercel.app",
          "X-Title": options.appTitle ?? "Crew",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        throw new TransportError("timeout", "OpenRouter request aborted");
      }
      throw new TransportError("apiError", `OpenRouter request failed: ${String(error)}`);
    }

    let parsed: CompletionBody;
    try {
      parsed = (await response.json()) as CompletionBody;
    } catch (error) {
      throw new TransportError("apiError", `OpenRouter returned a non-JSON body: ${String(error)}`);
    }
    if (!response.ok || parsed.error !== undefined) {
      const detail = parsed.error?.message ?? response.statusText;
      const raw = parsed.error?.metadata?.raw;
      const provider = parsed.error?.metadata?.provider_name;
      const upstream =
        raw === undefined
          ? ""
          : ` [${provider ?? "provider"}: ${typeof raw === "string" ? raw : JSON.stringify(raw)}]`;
      throw new TransportError("apiError", `OpenRouter ${response.status}: ${detail}${upstream}`);
    }

    const choice = parsed.choices?.[0];
    const finishReason = choice?.finish_reason ?? "other";
    const refusal = choice?.message?.refusal ?? undefined;
    const finish =
      refusal !== undefined
        ? "refusal"
        : finishReason === "stop"
          ? "stop"
          : finishReason === "length"
            ? "length"
            : "other";
    const usage = parsed.usage ?? {};
    return {
      model: parsed.model ?? request.model,
      content: choice?.message?.content ?? null,
      finish,
      ...(refusal === undefined ? {} : { refusal }),
      reasoningDetails: choice?.message?.reasoning_details ?? [],
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}
