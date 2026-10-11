/**
 * §requested-call-back: raising the call the narrator asked for (`NarratorState.callBack`, the
 * `requestCall` command). `departure` comes due the tick the ship casts off on a leg begun after
 * the request (`departing`, when `departed` is emitted; asked during `departing`, the first
 * `transit` tick of that same leg); `midLeg` halfway through a transit begun after the request, or
 * through the transit it was asked in before its halfway point. Each is per hop, never the whole
 * voyage. `arrival` comes due at the approach lead point (`approachLeadDistance`, where the staging
 * call is raised), and through `approaching` and `docking` while it waits; asked past that point
 * (`afterDocking`), the next leg's is meant. `afterCard` comes due the tick after a card was
 * answered with no follow-up to come (`cardResolvedTick`, written by `resolveDecision`), docked or
 * not. `nextPort` raises nothing here: the first story hook docked elsewhere serves it
 * (`core/hooks.ts`).
 *
 * Runs before `checkNotableEventHook`, so the requested call settles a notable owed from an
 * earlier tick (`raiseHookIfIdle` clears it) instead of queueing behind it. While another hook
 * is pending it is not raised; it is tried again the next tick, for as long as it stays due. The
 * staging call is raised earlier in the same tick (`advanceTravel`), so at a port with a dock map
 * an `arrival` call follows it, once it is answered.
 */
import { approachLeadDistance, raiseHookIfIdle } from "../../core/hooks";
import type { CallBackRequest } from "../../core/types/decisions";
import type { StepCtx } from "../../core/types/pipeline";

/** Is `request` (not yet served) due now? */
function isDue(ctx: StepCtx, request: CallBackRequest): boolean {
  const travel = ctx.state.travel;
  if (request.when === "nextPort") return false;
  if (request.when === "afterCard") {
    return request.cardResolvedTick !== undefined && ctx.tick > request.cardResolvedTick;
  }
  if (travel.stage === "docked") return false;
  const legBegunAfter = travel.stageStartedTick > request.requestedTick;
  switch (request.when) {
    case "departure":
      return (travel.stage === "departing" || travel.stage === "transit") && legBegunAfter;
    case "midLeg":
      return (
        travel.stage === "transit" &&
        travel.routeDistance > 0 &&
        travel.routeProgress >= travel.routeDistance / 2 &&
        (legBegunAfter || travel.stageStartedTick === request.legStartedTick)
      );
    case "arrival":
      if (request.afterDocking === true) return false;
      if (travel.stage === "transit") {
        return travel.routeDistance - travel.routeProgress <= approachLeadDistance(ctx);
      }
      return travel.stage === "approaching" || travel.stage === "docking";
  }
}

/** Raise `requestedCall` for a standing request (other than `nextPort`) that has come due. */
export function checkRequestedCall(ctx: StepCtx): void {
  const narrator = ctx.state.narrator;
  const request = narrator.callBack;
  if (request === undefined || request.servedByHookId !== undefined) return;
  // An `arrival` asked past a leg's lead point means the next leg's; docking ends this one.
  if (request.afterDocking === true && ctx.state.travel.stage === "docked") {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete request.afterDocking;
  }
  if (request.when === "nextPort" || !isDue(ctx, request)) return;
  const context = { when: request.when, why: request.why, requestedTick: request.requestedTick };
  if (!raiseHookIfIdle(ctx, "requestedCall", context)) return;
  const hook = narrator.pendingHook;
  if (hook === undefined) throw new Error("requestedCall was raised but no hook is pending");
  request.servedByHookId = hook.id;
}
