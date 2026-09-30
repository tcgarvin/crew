/**
 * The narrator function the server calls, and its default (W9 replaces `runNarrator` via
 * injection — see `routes/narrator.ts` — with the real LLM-backed implementation; this package
 * imports only *types* from `@crew/narrator`, never `@anthropic-ai/sdk`, so it has no LLM runtime
 * dependency of its own).
 */
import { randomUUID } from "node:crypto";
import type { NarratorRequest, NarratorResponse } from "@crew/narrator";

/** Context passed to `runNarrator`; carries secrets through without this package reading them. */
export interface NarratorCtx {
  readonly anthropicApiKey: string | undefined;
  readonly gameId: string;
}

export type RunNarrator = (req: NarratorRequest, ctx: NarratorCtx) => Promise<NarratorResponse>;

/**
 * Deterministic offline/test narrator: no commands, no card, no notes change. Keeps the game
 * playable end-to-end (hook fires, request round-trips, response applies as a no-op) before W9
 * lands. `docs/DEPLOYMENT.md` explains how to swap in the real one.
 */
export const nullNarrator: RunNarrator = async (_req, _ctx) => {
  return {
    commands: [],
    callId: randomUUID(),
  };
};
