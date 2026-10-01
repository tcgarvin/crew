/**
 * Raising narrator hooks (D5). `NarratorHook` halts `advance()` (see `world.ts` `haltReason`);
 * only one hook may be pending at a time, so raising is a no-op while one already is. Lived in
 * `systems/travel/hooks.ts` until D37 made the kernel core raise `policyDecision` hooks itself.
 */
import { allocateId } from "./ids";
import type { HookContexts, NarratorHookKind } from "./types/decisions";
import type { StepCtx } from "./types/pipeline";

/** Raise `kind` with `context` unless a hook is already pending. Returns whether it raised. */
export function raiseHookIfIdle<K extends NarratorHookKind>(
  ctx: StepCtx,
  kind: K,
  context: HookContexts[K],
): boolean {
  if (ctx.state.narrator.pendingHook !== undefined) return false;
  const hookId = allocateId(ctx.state, "hook");
  ctx.state.narrator.pendingHook = { id: hookId, kind, context, tick: ctx.tick } as never;
  ctx.emit({
    type: "narratorHookRaised",
    subjectIds: [hookId],
    causeIds: [],
    source: "sim",
    payload: { hookId, kind },
  });
  return true;
}
