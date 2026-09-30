/**
 * Narrator hook points owned by travel/commerce (PLAN §6 W6 item 5, D5).
 *
 * `NarratorHook` halts `advance()` (see `world.ts` `haltReason`, which W6 does not touch); only
 * one hook may be pending at a time, so every call here is a no-op while one already is.
 */
import { allocateId } from "../../core/ids";
import type { HookContexts, NarratorHookKind } from "../../core/types/decisions";
import type { StepCtx } from "../../core/types/pipeline";

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

/**
 * `jobBoard` (PLAN §6 item 5): raised while docked when the deterministic job source was free to
 * make an offer but had nothing to offer (e.g. a port with no `jobTemplates`), so a real narrator
 * gets a chance to flavour an otherwise-empty board. At most once per dock stay.
 */
export function raiseJobBoardHookIfNeeded(ctx: StepCtx, boardEmpty: boolean): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.narrator.jobBoardHookRaisedAtPortId;
    return;
  }
  if (!boardEmpty) return;
  if (ctx.state.narrator.jobBoardHookRaisedAtPortId === travel.portId) return;
  if (raiseHookIfIdle(ctx, "jobBoard", { portId: travel.portId })) {
    ctx.state.narrator.jobBoardHookRaisedAtPortId = travel.portId;
  }
}
