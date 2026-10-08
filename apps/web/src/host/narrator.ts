/**
 * Main-thread narrator call (Integration 2, D5, D43). When the worker halts on a hook, the main
 * thread POSTs `{gameId, hook, snapshot, recentEvents}` to `/api/games/:id/narrator`, forwards
 * the returned commands to the worker at the hook tick + 1 and keeps any card prose for the
 * modal (presentation only, W9 decision 39). A failure is classified here (`NarratorFailure`)
 * for the retry scheduler in `./narratorRetry.ts`: the hook stays unacknowledged while the
 * client retries, and the game pauses on an error if it keeps failing. Only the spacing rule
 * (429 `spacing`) acknowledges a hook without an answer: that is a rate rule, not a failure. The
 * one exception (D67) is the staging call: once its retries are spent it is acknowledged with no
 * plan, so the dock is the sim's floor set and the game never pauses for it.
 *
 * `apps/web/src` may not import `@crew/narrator` (dependency-cruiser `web-no-secrets`); the
 * response shape used here is restated structurally from its `NarratorResponse`.
 */
import type { DecisionCardText } from "@crew/content";
import type {
  Command,
  CommandId,
  NarratorCommand,
  NarratorHook,
  SaveEnvelope,
  SimEvent,
  Tick,
} from "@crew/sim";
import { type ApiResult, apiCall } from "./api";

/** The part of `NarratorResponse` the host acts on. */
export interface NarratorReply {
  readonly commands: readonly NarratorCommand[];
  readonly card?: DecisionCardText;
  readonly model?: string;
  readonly fallback?: string;
}

/** Vercel functions get ~30 s; the narrator itself gives up at 25 s. */
export const NARRATOR_CLIENT_TIMEOUT_MS = 30_000;

/** Notable/narrative events kept for the next call (oldest dropped first). */
export const RECENT_EVENTS_CAP = 60;

export interface NarratorCallDeps {
  readonly gameId: string;
  readonly token: string;
  readonly hook: NarratorHook;
  readonly snapshot: SaveEnvelope;
  readonly recentEvents: readonly SimEvent[];
}

/**
 * How the client treats a failed call (D43):
 * - `retryable`: a model or transport failure; retry with backoff, then the error panel.
 * - `fatal`: no point retrying (no narrator configured, a rejected request); the error panel.
 * - `spacing`: the min-tick spacing rule; acknowledge the hook with no answer, silently. The
 *   server applies it only to hooks the sim raises again (`quietTooLong`, `notableEvent`).
 */
export type NarratorFailureKind = "retryable" | "fatal" | "spacing";

export interface NarratorFailure {
  readonly kind: NarratorFailureKind;
  /**
   * The narrator's `FallbackReason` (`notConfigured`, `apiError`, `timeout`, `refusal`,
   * `truncated`, `schemaInvalid`) or the client's own: `network`, `server`, `request`,
   * `spacing`, `snapshot`, `malformed`.
   */
  readonly reason: string;
  /** The raw message, for the error panel's small print and the console. */
  readonly message: string;
}

export type NarratorOutcome =
  | { readonly ok: true; readonly reply: NarratorReply }
  | { readonly ok: false; readonly failure: NarratorFailure };

/** Classify an API failure for the retry scheduler (D43). */
export function classifyFailure(
  result: Extract<ApiResult<unknown>, { ok: false }>,
): NarratorFailure {
  const { status, code, message } = result;
  if (status === 0) {
    return { kind: "retryable", reason: code === "timeout" ? "timeout" : "network", message };
  }
  if (code === "badResponse") {
    // e.g. the dev server's HTML fallback when no API is running behind the proxy.
    return { kind: "retryable", reason: "network", message };
  }
  if (status === 429) {
    if (result.reason === "spacing") return { kind: "spacing", reason: "spacing", message };
    // No hourly cap since D102: any other 429 is someone else's throttle, so back off and retry.
    return { kind: "retryable", reason: "server", message };
  }
  if (code === "narratorUnavailable") {
    const reason = result.reason ?? "apiError";
    const retryable = result.retryable ?? reason !== "notConfigured";
    return { kind: retryable ? "retryable" : "fatal", reason, message };
  }
  if (status >= 500) return { kind: "retryable", reason: "server", message };
  return { kind: "fatal", reason: "request", message: `${code}: ${message}` };
}

export async function callNarrator(deps: NarratorCallDeps): Promise<NarratorOutcome> {
  const result = await apiCall<NarratorReply>(
    `/api/games/${encodeURIComponent(deps.gameId)}/narrator`,
    {
      method: "POST",
      token: deps.token,
      timeoutMs: NARRATOR_CLIENT_TIMEOUT_MS,
      body: {
        gameId: deps.gameId,
        hook: deps.hook,
        snapshot: deps.snapshot,
        recentEvents: deps.recentEvents,
      },
    },
  );
  if (!result.ok) return { ok: false, failure: classifyFailure(result) };
  const reply = result.body;
  if (!Array.isArray(reply.commands)) {
    return {
      ok: false,
      failure: { kind: "retryable", reason: "malformed", message: "malformed narrator response" },
    };
  }
  return { ok: true, reply };
}

let ackCounter = 0;

/**
 * The commands to send the worker for a hook: the narrator's (retargeted to `hookTick + 1`, the
 * earliest tick the halted world accepts), then `acknowledgeHook`. With no reply (the spacing
 * rule declined to narrate) this is just the acknowledgement.
 */
export function hookAnswer(
  hook: NarratorHook,
  hookTick: Tick,
  reply: NarratorReply | undefined,
): Command[] {
  const targetTick = hookTick + 1;
  const commands: Command[] = (reply?.commands ?? []).map(
    (command) => ({ ...command, targetTick }) as Command,
  );
  ackCounter += 1;
  commands.push({
    id: `cmd:system:ack:${hook.id}:${ackCounter}` as CommandId,
    source: "system",
    kind: "acknowledgeHook",
    payload: { hookId: hook.id },
    targetTick,
  } as Command);
  return commands;
}

/** Keep notable/narrative events for the next call, capped. */
export function appendRecentEvents(
  buffer: SimEvent[],
  events: readonly SimEvent[],
  cap = RECENT_EVENTS_CAP,
): void {
  for (const event of events) {
    if (event.significance === "notable" || event.significance === "narrative") buffer.push(event);
  }
  if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
}
