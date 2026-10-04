/**
 * Raising narrator hooks (D5). `NarratorHook` halts `advance()` (see `world.ts` `haltReason`);
 * only one hook may be pending at a time, so raising is a no-op while one already is. Lived in
 * `systems/travel/hooks.ts` until D37 made the kernel core raise `policyDecision` hooks itself.
 *
 * Raising any hook is narrator contact, so it re-arms the quiet timer: `lastNarrativeTick` is
 * set to the raise tick and `quietTooLong` (`core/pipeline.ts`) needs another full
 * `narrator.quietTooLongDays` of silence after it (passengers-and-galaxy §2.2: a long leg gets
 * one quiet check-in, never one ten seconds after another call).
 */
import { allocateId } from "./ids";
import type { HookContexts, NarratorHookKind } from "./types/decisions";
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
  // D69: a story call made after a hookable event reads it, so no `notableEvent` is owed for it
  // any more. The staging call cannot tell the story, so it leaves the debt standing.
  const owed = ctx.state.narrator.pendingNotable;
  if (kind !== "stageDock" && owed !== undefined && owed.tick < ctx.tick) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.narrator.pendingNotable;
  }
  const hookId = allocateId(ctx.state, "hook");
  ctx.state.narrator.pendingHook = { id: hookId, kind, context, tick: ctx.tick } as never;
  ctx.state.narrator.lastNarrativeTick = ctx.tick;
  ctx.emit({
    type: "narratorHookRaised",
    subjectIds: [hookId],
    causeIds: [],
    source: "sim",
    payload: { hookId, kind },
  });
  return true;
}
