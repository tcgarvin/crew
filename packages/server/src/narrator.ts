/**
 * The narrator function the server calls (W9). `defaultNarrator` runs `@crew/narrator`'s
 * `runNarrator` when an OpenRouter key is configured and the deterministic `nullNarrator`
 * otherwise; tests inject their own through `createApp({ runNarrator })`.
 */
import {
  type ModelTransport,
  type NarratorRequest,
  type NarratorResponse,
  nullNarratorResponse,
  openRouterTransport,
  runNarrator,
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
}

export type RunNarrator = (req: NarratorRequest, ctx: NarratorCtx) => Promise<NarratorResponse>;

/** Deterministic offline narrator: no commands, a template card for policy decisions. */
export const nullNarrator: RunNarrator = async (req) => nullNarratorResponse(req);

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
  return runNarrator(req, {
    gameId: ctx.gameId,
    notes: ctx.notes,
    ...(transport === undefined ? {} : { transport }),
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
  });
};
