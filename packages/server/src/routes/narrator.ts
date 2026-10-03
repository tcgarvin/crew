/**
 * `POST /api/games/:id/narrator` (W8). Validates the request, enforces per-game budgets, stores
 * the snapshot as a milestone save (its id is the `basis_save_id` for this call and for the next
 * budget check), calls the injected `runNarrator`, logs the call, and persists `notesUpdate`.
 *
 * D67: a `stageDock` hook is a staging call. It runs on the staging model, has its own hourly
 * budget, is never spaced (in either direction: it is neither refused as too soon nor counted as
 * the last call when a story call is spaced), and never writes notes. A staging failure is
 * answered like a story failure in `error` mode (502/503, so the client retries per D43); the
 * client then acknowledges with the floor set instead of pausing the game (D57's exception to
 * D43). In `null` mode the server answers with the floor set itself and logs
 * `[narrator] staging fallback <reason>`.
 */
import { gzipSync } from "node:zlib";
import type { NarratorRequest, NarratorResponse } from "@crew/narrator";
import type { Hono } from "hono";
import { z } from "zod";
import { type Db, narratorCallKind } from "../db/types";
import type { Env } from "../env";
import { type RunNarrator, isRetryableFailure, narratorFailure } from "../narrator";
import { saveEnvelopeSchema } from "../validation";
import { runAfterResponse } from "../waitUntil";

export interface NarratorRouteEnv {
  Variables: { userId: string };
}

/**
 * Loose shape check only: `hook`'s exact discriminated-union shape and `recentEvents`' element
 * shape are `@crew/sim` contracts this package doesn't re-validate field by field. The kernel
 * revalidates every returned command against live state on apply (PLAN rule 8), so a malformed
 * hook/event here fails safely downstream rather than needing to be caught twice.
 *
 * `gameId` is optional here even though it's required on `NarratorRequest`: the route already
 * takes the game id from the path (`:id`), so it's redundant in the body, and callers that don't
 * echo it (e.g. posting a `@crew/narrator` fixture verbatim) shouldn't 400 for omitting
 * information the server already has. When the body does include it, it must still agree with
 * the path (checked below) so a caller can't be confused about which game it's talking to.
 */
const narratorRequestSchema = z.object({
  gameId: z.string().min(1).optional(),
  hook: z.object({ kind: z.string().min(1) }).loose(),
  snapshot: saveEnvelopeSchema,
  recentEvents: z.array(z.unknown()),
});

// Server-side tunables not (yet) worth a dedicated env var; bump alongside playtesting feedback.
const NARRATOR_CALL_WINDOW_MS = 60 * 60 * 1000;
const MIN_TICKS_BETWEEN_NARRATOR_CALLS = 100;
/**
 * D37: hooks the player is waiting on. A policy card can follow another hook within a few ticks
 * (the departure gate right after an arrival), and refusing it would show the card undressed;
 * the hourly cap still applies.
 */
const SPACING_EXEMPT_HOOK_KINDS: ReadonlySet<string> = new Set(["policyDecision"]);

const MODEL_PLACEHOLDER = "null-narrator";
const PROMPT_VERSION_PLACEHOLDER = "v0";

export function registerNarratorRoutes(
  app: Hono<NarratorRouteEnv>,
  db: Db,
  env: Env,
  runNarrator: RunNarrator,
): void {
  app.post("/api/games/:id/narrator", async (c) => {
    const userId = c.get("userId");
    const gameId = c.req.param("id");
    const game = await db.getGame(gameId);
    if (!game || game.userId !== userId) {
      return c.json({ error: { code: "notFound", message: "No such game." } }, 404);
    }

    const raw = await c.req.json().catch(() => undefined);
    const parsed = narratorRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: { code: "badRequest", message: "Invalid narrator request body." },
          details: parsed.error.issues,
        },
        400,
      );
    }
    if (parsed.data.gameId !== undefined && parsed.data.gameId !== gameId) {
      return c.json(
        { error: { code: "badRequest", message: "gameId does not match the route." } },
        400,
      );
    }
    // Shape-checked, not deep-validated against `@crew/sim`'s exact unions (see schema comment).
    // `gameId` always comes from the path, not the (optional) body field — see schema comment.
    const reqBody = { ...parsed.data, gameId } as unknown as NarratorRequest;

    const kind = narratorCallKind(reqBody.hook.kind);
    const staging = kind === "staging";

    // Store the snapshot as a milestone save; it becomes this call's (and the next check's) basis.
    const snapshotBlob = gzipSync(Buffer.from(JSON.stringify(reqBody.snapshot), "utf8"));
    const basisSave = await db.putSave({
      gameId,
      blob: snapshotBlob,
      schemaVersion: reqBody.snapshot.schemaVersion,
      simVersion: reqBody.snapshot.simVersion,
      contentHash: reqBody.snapshot.contentHash,
      savedAtTick: reqBody.snapshot.savedAtTick,
      isMilestone: true,
    });

    const logRejection = (status: "budgetExceeded", error: string) =>
      db.logNarratorCall({
        gameId,
        hookKind: reqBody.hook.kind,
        basisSaveId: basisSave.id,
        model: MODEL_PLACEHOLDER,
        promptVersion: PROMPT_VERSION_PLACEHOLDER,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        status,
        request: reqBody,
        response: null,
        error,
      });

    // The 429 body says which rule fired (D43): the client waits out the hourly cap but treats
    // spacing as a deliberate "no narration this time", not a failure.
    const callsInWindow = await db.countNarratorCallsSince(gameId, NARRATOR_CALL_WINDOW_MS, kind);
    if (callsInWindow >= env.narratorMaxCallsPerHour) {
      const message = `Hourly narrator call budget (${env.narratorMaxCallsPerHour}) exceeded for this game.`;
      await logRejection("budgetExceeded", message);
      return c.json({ error: { code: "budgetExceeded", reason: "hourly", message } }, 429);
    }

    // Spacing is measured from the last story call the model answered: a failed attempt narrated
    // nothing, so the client's retry of the same hook (D43) must not be refused as "too soon",
    // and a staging call (D67) is not story, so it neither is spaced nor spaces the next one.
    const [lastCall] =
      staging || SPACING_EXEMPT_HOOK_KINDS.has(reqBody.hook.kind)
        ? []
        : await db.listNarratorCalls({ gameId, status: "ok", kind: "story", limit: 1 });
    if (lastCall) {
      const lastBasis = await db.getSave(lastCall.basisSaveId);
      const lastTick = lastBasis?.savedAtTick ?? 0;
      if (reqBody.snapshot.savedAtTick - lastTick < MIN_TICKS_BETWEEN_NARRATOR_CALLS) {
        const message = `Too soon since the last narrator call (min ${MIN_TICKS_BETWEEN_NARRATOR_CALLS} ticks).`;
        await logRejection("budgetExceeded", message);
        return c.json({ error: { code: "budgetExceeded", reason: "spacing", message } }, 429);
      }
    }

    const startedAt = Date.now();
    try {
      const outcome = await runNarrator(reqBody, {
        openRouterApiKey: env.openRouterApiKey,
        gameId,
        notes: game.narrativeNotes,
        model: staging ? env.stagingModel : env.narratorModel,
      });
      const response: NarratorResponse = outcome.response;
      const latencyMs = Date.now() - startedAt;
      const failure = narratorFailure(outcome);
      if (failure !== undefined && staging && env.narratorFallback === "null") {
        // D67: the server answers with the floor set (the null narrator's empty plan) and says
        // so; never an error panel for staging.
        console.warn(`[narrator] staging fallback ${failure.reason}`, {
          gameId,
          model: response.model,
          promptVersion: response.promptVersion,
          latencyMs,
          error: failure.message,
        });
      } else if (response.fallback !== undefined) {
        // D42: the fallback is otherwise only visible in the call log. Nothing here can carry
        // the API key: `error` is the narrator's own failure text (for a transport failure,
        // `OpenRouter <status>: <response body>`), never the request or its headers.
        console.warn("[narrator] fallback", {
          gameId,
          hookKind: reqBody.hook.kind,
          fallback: response.fallback,
          model: response.model,
          promptVersion: response.promptVersion,
          latencyMs,
          error: outcome.error ?? null,
        });
      }

      if (response.dropped !== undefined && response.dropped.length > 0) {
        // D46: an intent the translator dropped is otherwise only visible in the call log's
        // response jsonb. Kinds and reasons only: the reasons are the translator's own text,
        // never the model's prose or the request.
        console.warn("[narrator] dropped", {
          gameId,
          hookKind: reqBody.hook.kind,
          dropped: response.dropped.map((d) => ({ kind: d.kind, reason: d.reason })),
        });
      }

      // D43: in `error` mode a fallback is refused, never served. The call is logged as an
      // error with its reason; the client retries (the sim stays halted) or pauses the game, or
      // for a staging call (D67) acknowledges the hook with the floor set once it gives up.
      if (failure !== undefined && env.narratorFallback === "error") {
        await db.logNarratorCall({
          gameId,
          hookKind: reqBody.hook.kind,
          basisSaveId: basisSave.id,
          model: response.model,
          promptVersion: response.promptVersion,
          inputTokens: null,
          outputTokens: null,
          latencyMs,
          status: "error",
          request: reqBody,
          response: null,
          error: `${failure.reason}: ${failure.message}`,
        });
        const retryable = isRetryableFailure(failure);
        return c.json(
          {
            error: {
              code: "narratorUnavailable",
              reason: failure.reason,
              message: failure.message,
              retryable,
            },
          },
          retryable ? 502 : 503,
        );
      }

      await runAfterResponse(async () => {
        await db.logNarratorCall({
          gameId,
          hookKind: reqBody.hook.kind,
          basisSaveId: basisSave.id,
          // W9: the response carries model, prompt version and usage; `fallback` (null path and
          // why) is kept in the `response` jsonb.
          model: response.model,
          promptVersion: response.promptVersion,
          inputTokens: response.usage?.inputTokens ?? null,
          outputTokens: response.usage?.outputTokens ?? null,
          latencyMs,
          status: "ok",
          request: reqBody,
          response,
          error: null,
        });
        // D67: the staging call never writes notes (the narrator sends none for it; the
        // route does not take its word for that).
        if (!staging && response.notesUpdate !== undefined) {
          await db.updateNotes(gameId, response.notesUpdate);
        }
      });

      return c.json(response);
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : "Unknown narrator error.";
      console.error("[narrator] failed", {
        gameId,
        hookKind: reqBody.hook.kind,
        model: MODEL_PLACEHOLDER,
        promptVersion: PROMPT_VERSION_PLACEHOLDER,
        latencyMs,
        error: message,
      });
      await db.logNarratorCall({
        gameId,
        hookKind: reqBody.hook.kind,
        basisSaveId: basisSave.id,
        model: MODEL_PLACEHOLDER,
        promptVersion: PROMPT_VERSION_PLACEHOLDER,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        status: "error",
        request: reqBody,
        response: null,
        error: message,
      });
      return c.json({ error: { code: "narratorFailed", message } }, 502);
    }
  });
}
