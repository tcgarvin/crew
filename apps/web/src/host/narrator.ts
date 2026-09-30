/**
 * Main-thread narrator call (Integration 2, D5). When the worker halts on a hook, the main
 * thread POSTs `{gameId, hook, snapshot, recentEvents}` to `/api/games/:id/narrator`, forwards
 * the returned commands to the worker at the hook tick + 1, keeps any card prose for the modal
 * (presentation only, W9 decision 39), and always acknowledges the hook — on failure too, so the
 * sim is never left halted.
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
import { apiCall } from "./api";

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

export type NarratorOutcome =
  | { readonly ok: true; readonly reply: NarratorReply }
  | { readonly ok: false; readonly reason: string };

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
  if (!result.ok) return { ok: false, reason: `${result.code}: ${result.message}` };
  const reply = result.body;
  if (!Array.isArray(reply.commands)) return { ok: false, reason: "malformed narrator response" };
  return { ok: true, reply };
}

let ackCounter = 0;

/**
 * The commands to send the worker for a hook: the narrator's (retargeted to `hookTick + 1`, the
 * earliest tick the halted world accepts), then `acknowledgeHook`. With no reply (failure,
 * offline) this is just the acknowledgement.
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
