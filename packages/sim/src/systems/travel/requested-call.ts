/**
 * D99: raising the call the narrator asked for (`NarratorState.callBack`, the `requestCall`
 * command). `departure` comes due the tick the ship casts off on a leg begun after the request
 * (`departing`, when `departed` is emitted; asked during `departing`, the first `transit` tick of
 * that same leg); `midLeg` halfway through a transit begun after the request, or through the
 * transit it was asked in before its halfway point. Each is per hop, never the whole voyage.
 * `nextPort` raises nothing here: the first story hook docked elsewhere serves it
 * (`core/hooks.ts`).
 *
 * Runs before `checkNotableEventHook`, so the requested call settles a notable owed from an
 * earlier tick (`raiseHookIfIdle` clears it) instead of queueing behind it. While another hook
 * is pending it is not raised; it is tried again the next tick, for as long as it stays due.
 */
import { raiseHookIfIdle } from "../../core/hooks";
import type { CallBackRequest } from "../../core/types/decisions";
import type { StepCtx } from "../../core/types/pipeline";
import type { TravelState } from "../../core/types/travel";

/** Is `request` (departure or midLeg, not yet served) due with travel as it stands? */
function isDue(request: CallBackRequest, travel: TravelState): boolean {
  if (travel.stage === "docked") return false;
  const legBegunAfter = travel.stageStartedTick > request.requestedTick;
  switch (request.when) {
    case "nextPort":
      return false;
    case "departure":
      return (travel.stage === "departing" || travel.stage === "transit") && legBegunAfter;
    case "midLeg":
      return (
        travel.stage === "transit" &&
        travel.routeDistance > 0 &&
        travel.routeProgress >= travel.routeDistance / 2 &&
        (legBegunAfter || travel.stageStartedTick === request.legStartedTick)
      );
  }
}

/** Raise `requestedCall` for a standing departure or midLeg request that has come due. */
export function checkRequestedCall(ctx: StepCtx): void {
  const narrator = ctx.state.narrator;
  const request = narrator.callBack;
  if (request === undefined || request.servedByHookId !== undefined) return;
  if (request.when === "nextPort" || !isDue(request, ctx.state.travel)) return;
  const context = { when: request.when, why: request.why, requestedTick: request.requestedTick };
  if (!raiseHookIfIdle(ctx, "requestedCall", context)) return;
  const hook = narrator.pendingHook;
  if (hook === undefined) throw new Error("requestedCall was raised but no hook is pending");
  request.servedByHookId = hook.id;
}
