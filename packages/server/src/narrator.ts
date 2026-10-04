/**
 * The narrator function the server calls (W9). `defaultNarrator` runs `@crew/narrator`'s
 * `runNarrator` when an OpenRouter key is configured and otherwise answers with the
 * deterministic null response marked `notConfigured`, which the route refuses in
 * `CREW_NARRATOR_FALLBACK=error` mode (D43); tests inject their own through
 * `createApp({ runNarrator })`.
 */
import {
  type FallbackReason,
  type NarratorRequest,
  type NarratorResponse,
  defaultContent,
  nullNarratorResponse,
  openRouterTransport,
  runNarratorWithTrace,
} from "@crew/narrator";

/** Context passed to a `RunNarrator`; carries secrets through without this package using them. */
export interface NarratorCtx {
  /** `OPENROUTER_API_KEY`. */
  readonly openRouterApiKey: string | undefined;
  readonly gameId: string;
  /** Stored `games.narrative_notes` jsonb, as read from the db (parsed by the narrator). */
  readonly notes?: unknown;
  /** `CREW_NARRATOR_MODEL`; absent = the narrator's default. */
  readonly model?: string;
  /** D70: the model timeout for this call (`CREW_STAGING_TIMEOUT_MS` for staging); absent = default. */
  readonly timeoutMs?: number;
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

/**
 * Deterministic offline narrator: a template card for policy decisions and, for
 * `captainAshore`, one templated job offer (D40: the narrator is the only source of
 * work, so the offline path must still hand out work).
 */
export const nullNarrator: RunNarrator = async (req) => ({
  // The null narrator needs the content bundle for its offers (D40).
  response: nullNarratorResponse(req, { content: defaultContent() }),
});

/**
 * Without a key the null narrator answers, marked `fallback: "notConfigured"` so the route can
 * refuse it in `error` mode (D43) and the call log says why the template path was taken.
 */
export const defaultNarrator: RunNarrator = async (req, ctx) => {
  if (ctx.openRouterApiKey === undefined || ctx.openRouterApiKey === "") {
    return {
      response: nullNarratorResponse(req, {
        content: defaultContent(),
        fallback: "notConfigured",
      }),
      error: "no OPENROUTER_API_KEY configured",
    };
  }
  const run = await runNarratorWithTrace(req, {
    gameId: ctx.gameId,
    notes: ctx.notes,
    transport: openRouterTransport({ apiKey: ctx.openRouterApiKey }),
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
  });
  return { response: run.response, ...(run.error === undefined ? {} : { error: run.error }) };
};
