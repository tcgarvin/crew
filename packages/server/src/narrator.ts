/**
 * The narrator function the server calls (W9). `defaultNarrator` runs `@crew/narrator`'s
 * `runNarrator` when an OpenRouter key is configured and otherwise answers with the
 * deterministic null response marked `notConfigured`, which the route refuses in
 * `CREW_NARRATOR_FALLBACK=error` mode (D43); tests inject their own through
 * `createApp({ runNarrator })`.
 */
import { loadBundle } from "@crew/content";
import {
  type FallbackReason,
  type ModelTransport,
  type NarratorRequest,
  type NarratorResponse,
  nullNarratorResponse,
  openRouterTransport,
  runNarratorWithTrace,
} from "@crew/narrator";
import type { ContentBundle } from "@crew/sim";

/** Context passed to a `RunNarrator`; carries secrets through without this package using them. */
export interface NarratorCtx {
  /** `OPENROUTER_API_KEY`. */
  readonly openRouterApiKey: string | undefined;
  readonly gameId: string;
  /** Stored `games.narrative_notes` jsonb, as read from the db (parsed by the narrator). */
  readonly notes?: unknown;
  /** `CREW_NARRATOR_MODEL`; absent = the narrator's default. */
  readonly model?: string;
}

/**
 * What a narrator call hands the route: the response the client gets, plus, when the response
 * is the fallback (`response.fallback` set), why (D42: the route logs it; the message never
 * carries the API key or the request body).
 */
export interface NarratorOutcome {
  readonly response: NarratorResponse;
  readonly error?: string;
}

/** D43: why a narrator call could not be answered by the model, as the route reports it. */
export interface NarratorFailure {
  readonly reason: FallbackReason;
  readonly message: string;
}

/**
 * D43: the failure behind a fallback outcome, or `undefined` when the model answered. Only
 * `notConfigured` is final; every other reason is a transient model failure the client retries.
 */
export function narratorFailure(outcome: NarratorOutcome): NarratorFailure | undefined {
  const reason = outcome.response.fallback;
  if (reason === undefined) return undefined;
  return { reason, message: outcome.error ?? `narrator fallback: ${reason}` };
}

export function isRetryableFailure(failure: NarratorFailure): boolean {
  return failure.reason !== "notConfigured";
}

export type RunNarrator = (req: NarratorRequest, ctx: NarratorCtx) => Promise<NarratorOutcome>;

let cachedBundle: ContentBundle | undefined;

/** The validated content bundle, loaded once; the null narrator needs it for its offers (D40). */
function content(): ContentBundle {
  if (cachedBundle === undefined) {
    const result = loadBundle();
    if (!result.ok) {
      throw new Error(
        `narrator: content bundle failed validation (${result.issues.length} issues)`,
      );
    }
    cachedBundle = result.bundle;
  }
  return cachedBundle;
}

/**
 * Deterministic offline narrator: a template card for policy decisions and, for
 * `approachingPort`/`jobBoard`, one templated job offer (D40: the narrator is the only source of
 * work, so the offline path must still hand out work).
 */
export const nullNarrator: RunNarrator = async (req) => ({
  response: nullNarratorResponse(req, { content: content() }),
});

/**
 * W9 decision: OpenRouter transport (owner). The transport that sends the key to OpenRouter is
 * not implemented yet (see the W9 report); until it is, a configured key still yields the null
 * fallback, marked `fallback: "notConfigured"` in the call log.
 */
function transportFor(apiKey: string): ModelTransport | undefined {
  return openRouterTransport({ apiKey });
}

/**
 * Without a key the null narrator answers, marked `fallback: "notConfigured"` so the route can
 * refuse it in `error` mode (D43) and the call log says why the template path was taken.
 */
export const defaultNarrator: RunNarrator = async (req, ctx) => {
  if (ctx.openRouterApiKey === undefined || ctx.openRouterApiKey === "") {
    return {
      response: nullNarratorResponse(req, { content: content(), fallback: "notConfigured" }),
      error: "no OPENROUTER_API_KEY configured",
    };
  }
  const transport = transportFor(ctx.openRouterApiKey);
  const run = await runNarratorWithTrace(req, {
    gameId: ctx.gameId,
    notes: ctx.notes,
    ...(transport === undefined ? {} : { transport }),
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
  });
  return { response: run.response, ...(run.error === undefined ? {} : { error: run.error }) };
};
