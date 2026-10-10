/**
 * Raising narrator hooks (D5). `NarratorHook` halts `advance()` (see `world.ts` `haltReason`);
 * only one hook may be pending at a time, so raising is a no-op while one already is.
 *
 * Raising any hook is narrator contact, so it re-arms the quiet timer: `lastNarrativeTick` is
 * set to the raise tick and `quietTooLong` (`core/pipeline.ts`) needs another full
 * `narrator.quietTooLongDays` of silence after it (passengers-and-galaxy §2.2: a long leg gets
 * one quiet check-in, never one ten seconds after another call).
 */
import { allocateId } from "./ids";
import type { HookContexts, NarratorHookKind } from "./types/decisions";
import type { HookId } from "./types/ids";
import type { StepCtx } from "./types/pipeline";

/**
 * Raise `kind` with `context` unless a hook is already pending, re-arming the quiet timer.
 * Returns whether it raised.
 */
export function raiseHookIfIdle<K extends NarratorHookKind>(
  ctx: StepCtx,
  kind: K,
  context: HookContexts[K],
): boolean {
  if (ctx.state.narrator.pendingHook !== undefined) return false;
  // §notable-event-hook: a story call made after a hookable event reads it, so no `notableEvent`
  // is owed for it. The staging call cannot tell the story, so it leaves the debt standing.
  const owed = ctx.state.narrator.pendingNotable;
  if (kind !== "stageDock" && owed !== undefined && owed.tick < ctx.tick) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.narrator.pendingNotable;
  }
  const hookId = allocateId(ctx.state, "hook");
  ctx.state.narrator.pendingHook = { id: hookId, kind, context, tick: ctx.tick } as never;
  ctx.state.narrator.lastNarrativeTick = ctx.tick;
  if (kind !== "stageDock") serveNextPortRequest(ctx, hookId);
  ctx.emit({
    type: "narratorHookRaised",
    subjectIds: [hookId],
    causeIds: [],
    source: "sim",
    payload: { hookId, kind },
  });
  return true;
}

/**
 * §requested-call-back: a `nextPort` call-back request is served by the first story hook raised
 * while docked at a port other than the one it was asked at (any port, if it was asked in flight);
 * the digest reads it back on that call, and acknowledging the hook spends it.
 */
function serveNextPortRequest(ctx: StepCtx, hookId: HookId): void {
  const request = ctx.state.narrator.callBack;
  if (request === undefined || request.when !== "nextPort") return;
  if (request.servedByHookId !== undefined) return;
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return;
  if (request.portId !== undefined && request.portId === travel.portId) return;
  request.servedByHookId = hookId;
}
