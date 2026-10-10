/**
 * `POST /api/games/:id/narrator` (W8). Validates the request, enforces the tick spacing, stores
 * the snapshot as a milestone save (its id is the `basis_save_id` for this call and for the next
 * spacing check), calls the injected `runNarrator`, logs the call, and persists `notesUpdate`.
 * There is no call cap in software (D102): the OpenRouter key's own limit guards spending.
 *
 * §staging-call-on-the-server: a `stageDock` hook is a staging call. It runs on the staging model,
 * is never spaced (in either direction: it is neither refused as too soon nor counted as the last
 * call when a story call is spaced), and never writes notes. A staging failure is answered like a
 * story failure in `error` mode (502/503, so the client retries per D43); the client then
 * acknowledges with the floor set instead of pausing the game (D57's exception to D43). In `null`
 * mode the server answers with the floor set itself and logs `[narrator] staging fallback
 * <reason>`.
 *
 * §notes-turn: a story call the model answered is followed by its notes turn, after the response: a
 * `notes` row is logged `pending` before the plan goes out and finished when the notes are
 * stored. A call that arrives while that row is pending waits for it (up to `NOTES_WAIT_MS`), so
 * it always reads the notes the previous call wrote.
 */
import { gzipSync } from "node:zlib";
import {
  NOTES_TIMEOUT_MS,
  type NarratorRequest,
  type NarratorResponse,
  type NotesRun,
} from "@crew/narrator";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { type Db, type LogNarratorCallInput, NOTES_HOOK_KIND, narratorCallKind } from "../db/types";
import type { Env } from "../env";
import { apiError, loadOwnedGame, parseJsonBody } from "../http";
import {
  type NarratorOutcome,
  type RunNarrator,
  isRetryableFailure,
  narratorFailure,
} from "../narrator";
import { saveEnvelopeSchema } from "../validation";
import { runAfterResponse } from "../waitUntil";

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

// A server-side tunable not (yet) worth a dedicated env var; bump alongside playtesting feedback.
const MIN_TICKS_BETWEEN_NARRATOR_CALLS = 100;
/**
 * Hooks the sim raises once and never again, so a spacing refusal (which the client acknowledges
 * unanswered, D43) would lose them for good. The spacing rule is
 * for the hooks the sim raises again on its own (`quietTooLong`, `notableEvent`): a refused one
 * costs one check-in.
 * - `policyDecision` (§call-spacing): a policy card can follow another hook within a few ticks (the
 *   departure gate right after an arrival), and refusing it would show the card undressed.
 * - `captainAshore` (§call-spacing): asked once per docking, the tick the captain steps onto the
 * dock,
 *   which can come a few ticks after another call (the delivery's `notableEvent` at a
 *   destination). Refused, the docking's one ask was spent on nothing and the ship looked for
 *   work for good (offline, the ask is the only source of work). The sim already spaces it: one
 *   per docking.
 * - `requestedCall` (§call-spacing): raised once, at the cast-off or mid-leg the narrator asked
 * for; a
 *   spacing refusal would lose it for good, and the sim raises it only for a request it holds.
 */
const SPACING_EXEMPT_HOOK_KINDS: ReadonlySet<string> = new Set([
  "policyDecision",
  "captainAshore",
  "requestedCall",
]);

/**
 * §notes-turn: how long a call waits for the previous call's notes turn: its timeout plus slack for
 * the database writes. A pending row older than this is a notes turn that died (the function was
 * cut off): it is ignored.
 */
const NOTES_WAIT_MS = NOTES_TIMEOUT_MS + 5_000;
const NOTES_POLL_MS = 500;

/**
 * §notes-turn: the game's notes once no notes turn is pending, or, if one is still pending after
 * `NOTES_WAIT_MS`, the notes as they stand (the plan's, without the model's rewrite).
 */
async function settledNotes(db: Db, gameId: string): Promise<unknown> {
  const startedAt = Date.now();
  for (;;) {
    const [pending] = await db.listNarratorCalls({
      gameId,
      hookKind: NOTES_HOOK_KIND,
      status: "pending",
      limit: 1,
    });
    const now = Date.now();
    if (pending === undefined || now - pending.createdAt.getTime() > NOTES_WAIT_MS) break;
    if (now - startedAt > NOTES_WAIT_MS) {
      console.warn("[narrator] notes turn still pending; reading the notes as they stand", {
        gameId,
        notesCallId: pending.id,
      });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, NOTES_POLL_MS));
  }
  const game = await db.getGame(gameId);
  if (game === undefined) throw new Error(`settledNotes: game ${gameId} disappeared`);
  return game.narrativeNotes;
}

/**
 * §notes-turn: runs a notes turn and finishes its pending row; never throws (it runs after the
 * response).
 */
async function finishNotesTurn(
  db: Db,
  gameId: string,
  rowId: string,
  notesTurn: () => Promise<NotesRun>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const run = await notesTurn();
    const latencyMs = Date.now() - startedAt;
    if (run.ok) {
      await db.updateNotes(gameId, run.notes);
      await db.finishNarratorCall(rowId, {
        model: run.model,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        latencyMs,
        status: "ok",
        response: { notes: run.notes, usage: run.usage },
        error: null,
      });
      return;
    }
    console.warn("[narrator] notes turn failed", { gameId, reason: run.reason, error: run.error });
    await db.finishNarratorCall(rowId, {
      model: MODEL_PLACEHOLDER,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      status: "error",
      response: run.rawContent === undefined ? null : { rawContent: run.rawContent },
      error: `${run.reason}: ${run.error}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[narrator] notes turn threw", { gameId, error: message });
    await db
      .finishNarratorCall(rowId, {
        model: MODEL_PLACEHOLDER,
        inputTokens: null,
        outputTokens: null,
        latencyMs: Date.now() - startedAt,
        status: "error",
        response: null,
        error: message,
      })
      .catch((finishErr: unknown) =>
        console.error("[narrator] could not finish the notes row", {
          gameId,
          error: finishErr instanceof Error ? finishErr.message : String(finishErr),
        }),
      );
  }
}

const MODEL_PLACEHOLDER = "null-narrator";
const PROMPT_VERSION_PLACEHOLDER = "v0";

/** The log fields of a call the model never answered (refused, or the narrator threw). */
const UNANSWERED = {
  model: MODEL_PLACEHOLDER,
  promptVersion: PROMPT_VERSION_PLACEHOLDER,
  inputTokens: null,
  outputTokens: null,
  response: null,
} as const;

/**
 * The warn lines a narrator answer can leave in the server log. `stagingFloor`: a staging call
 * in `null` mode, whose failure is answered with the floor set.
 */
function warnAboutAnswer(
  gameId: string,
  hookKind: string,
  outcome: NarratorOutcome,
  latencyMs: number,
  { stagingFloor }: { readonly stagingFloor: boolean },
): void {
  const response = outcome.response;
  const failure = narratorFailure(outcome);
  if (stagingFloor && failure !== undefined) {
    // §staging-call-on-the-server: the server answers with the floor set (the null narrator's empty
    // plan) and says so; never an error panel for staging.
    console.warn(`[narrator] staging fallback ${failure.reason}`, {
      gameId,
      model: response.model,
      promptVersion: response.promptVersion,
      latencyMs,
      error: failure.message,
    });
  } else if (response.fallback !== undefined) {
    // The fallback is otherwise only visible in the call log. Nothing here can carry
    // the API key: `error` is the narrator's own failure text (for a transport failure,
    // `OpenRouter <status>: <response body>`), never the request or its headers.
    console.warn("[narrator] fallback", {
      gameId,
      hookKind,
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
      hookKind,
      dropped: response.dropped.map((d) => ({ kind: d.kind, reason: d.reason })),
    });
  }
}

export function registerNarratorRoutes(
  app: Hono<AppEnv>,
  db: Db,
  env: Env,
  runNarrator: RunNarrator,
): void {
  app.post("/api/games/:id/narrator", async (c) => {
    const gameId = c.req.param("id");
    const game = await loadOwnedGame(db, c.get("userId"), gameId);
    if (!game) return apiError(c, 404, "notFound", "No such game.");

    const parsed = await parseJsonBody(c, narratorRequestSchema);
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
      return apiError(c, 400, "badRequest", "gameId does not match the route.");
    }
    // Shape-checked, not deep-validated against `@crew/sim`'s exact unions (see schema comment).
    // `gameId` always comes from the path, not the (optional) body field — see schema comment.
    const reqBody = { ...parsed.data, gameId } as unknown as NarratorRequest;

    const kind = narratorCallKind(reqBody.hook.kind);
    if (kind === "notes") {
      return apiError(c, 400, "badRequest", "notes is not a hook kind.");
    }
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

    type CallLogFields = Omit<
      LogNarratorCallInput,
      "gameId" | "hookKind" | "basisSaveId" | "request"
    >;
    const logCall = (fields: CallLogFields) =>
      db.logNarratorCall({
        gameId,
        hookKind: reqBody.hook.kind,
        basisSaveId: basisSave.id,
        request: reqBody,
        ...fields,
      });
    const logRejection = (error: string) =>
      logCall({ ...UNANSWERED, latencyMs: null, status: "budgetExceeded", error });

    // Spacing is measured from the last story call the model answered: a failed attempt narrated
    // nothing, so the client's retry of the same hook (D43) must not be refused as "too soon",
    // and a staging call (§staging-call-on-the-server) is not story, so it neither is spaced nor
    // spaces the next one.
    const [lastCall] =
      staging || SPACING_EXEMPT_HOOK_KINDS.has(reqBody.hook.kind)
        ? []
        : await db.listNarratorCalls({ gameId, status: "ok", kind: "story", limit: 1 });
    if (lastCall) {
      const lastBasis = await db.getSave(lastCall.basisSaveId);
      const lastTick = lastBasis?.savedAtTick ?? 0;
      if (reqBody.snapshot.savedAtTick - lastTick < MIN_TICKS_BETWEEN_NARRATOR_CALLS) {
        const message = `Too soon since the last narrator call (min ${MIN_TICKS_BETWEEN_NARRATOR_CALLS} ticks).`;
        await logRejection(message);
        // The client treats spacing as a deliberate "no narration this time", not a failure (D43).
        return apiError(c, 429, "budgetExceeded", message, { reason: "spacing" });
      }
    }

    const notes = await settledNotes(db, gameId);
    const startedAt = Date.now();
    try {
      const outcome = await runNarrator(reqBody, {
        openRouterApiKey: env.openRouterApiKey,
        gameId,
        notes,
        model: staging ? env.stagingModel : env.narratorModel,
        reasoningEffort: staging ? env.stagingReasoningEffort : env.narratorReasoningEffort,
        ...(staging ? { timeoutMs: env.stagingTimeoutMs } : {}),
      });
      const response: NarratorResponse = outcome.response;
      const latencyMs = Date.now() - startedAt;
      const failure = narratorFailure(outcome);
      warnAboutAnswer(gameId, reqBody.hook.kind, outcome, latencyMs, {
        stagingFloor: staging && env.narratorFallback === "null",
      });

      // D43: in `error` mode a fallback is refused, never served. The call is logged as an
      // error with its reason; the client retries (the sim stays halted) or pauses the game, or
      // for a staging call (§staging-call-on-the-server) acknowledges the hook with the floor set
      // once it gives up.
      if (failure !== undefined && env.narratorFallback === "error") {
        await logCall({
          ...UNANSWERED,
          model: response.model,
          promptVersion: response.promptVersion,
          latencyMs,
          status: "error",
          error: `${failure.reason}: ${failure.message}`,
        });
        const retryable = isRetryableFailure(failure);
        return apiError(c, retryable ? 502 : 503, "narratorUnavailable", failure.message, {
          reason: failure.reason,
          retryable,
        });
      }

      // §notes-turn: written before the response, so the next call sees this one's notes or waits
      // for them: the log row, the notes as they stand after the plan, and the pending notes row.
      await logCall({
        // W9: the response carries model, prompt version and usage; `fallback` (null path and
        // why) is kept in the `response` jsonb.
        model: response.model,
        promptVersion: response.promptVersion,
        inputTokens: response.usage?.inputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
        latencyMs,
        status: "ok",
        response,
        error: null,
      });
      // §staging-call-on-the-server: the staging call never writes notes (the narrator sends none
      // for it; the route does not take its word for that).
      if (!staging && response.notesUpdate !== undefined) {
        await db.updateNotes(gameId, response.notesUpdate);
      }
      const notesTurn = outcome.notesTurn;
      if (!staging && notesTurn !== undefined) {
        const pending = await db.logNarratorCall({
          gameId,
          hookKind: NOTES_HOOK_KIND,
          basisSaveId: basisSave.id,
          model: response.model,
          promptVersion: response.promptVersion,
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
          status: "pending",
          request: { forHook: reqBody.hook.kind, callId: response.callId },
          response: null,
          error: null,
        });
        await runAfterResponse(
          () => finishNotesTurn(db, gameId, pending.id, notesTurn),
          env.onVercel,
        );
      }

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
      await logCall({ ...UNANSWERED, latencyMs, status: "error", error: message });
      return apiError(c, 502, "narratorFailed", message);
    }
  });
}
