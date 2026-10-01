/**
 * The narrator function the server calls (W9). `defaultNarrator` runs `@crew/narrator`'s
 * `runNarrator` when an OpenRouter key is configured and the deterministic `nullNarrator`
 * otherwise; tests inject their own through `createApp({ runNarrator })`.
 */
import { loadBundle } from "@crew/content";
import {
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

export const defaultNarrator: RunNarrator = async (req, ctx) => {
  if (ctx.openRouterApiKey === undefined || ctx.openRouterApiKey === "") {
    return nullNarrator(req, ctx);
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
