/**
 * OpenRouter implementation of `ModelTransport` (D15).
 *
 * One OpenAI-compatible chat completion with `response_format: json_schema` (strict). The
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
    readonly message?: { readonly content?: string | null; readonly refusal?: string | null };
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

export function openRouterTransport(options: OpenRouterOptions): ModelTransport {
  const doFetch = options.fetch ?? fetch;
  return async (request: ModelRequest): Promise<ModelResult> => {
    const systemParts = systemContentParts(request.system);
    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: [
        { role: "system", content: systemParts },
        { role: "user", content: request.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema },
      },
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
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}
