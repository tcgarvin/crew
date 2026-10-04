/**
 * Retry scheduler for narrator calls (D43): a pure state machine the host drives. Feed it the
 * failure of each attempt and it says what to do next: wait and retry, acknowledge the hook
 * without an answer (spacing rule only), or give up so the game pauses on the error panel.
 *
 * A model/transport failure backs off through `RETRY_DELAYS_MS` (about a minute in all, which
 * the run-ahead lead mostly hides). The hourly call budget is waited out in
 * `BUDGET_RETRY_DELAY_MS` steps for up to `BUDGET_RETRY_WINDOW_MS`. A fatal failure gives up at
 * once. The two counters are independent, so a budget wait does not use up the model retries.
 */
import type { NarratorFailure } from "./narrator";

/** Backoff between model/transport retries: 2 s, 4 s, 8 s, 16 s, 30 s (about 60 s in all). */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];
/** Hourly budget: poll every 30 s ... */
export const BUDGET_RETRY_DELAY_MS = 30_000;
/** ... for up to 5 minutes before the error panel. */
export const BUDGET_RETRY_WINDOW_MS = 5 * 60_000;

export interface RetryState {
  /** Model/transport failures so far; indexes `RETRY_DELAYS_MS`. */
  readonly failures: number;
  /** Budget (429 hourly) waits so far. */
  readonly budgetWaits: number;
}

export const INITIAL_RETRY_STATE: RetryState = { failures: 0, budgetWaits: 0 };

export type RetryAction =
  | {
      readonly type: "retry";
      readonly delayMs: number;
      /** The attempt about to be made (the first call was attempt 1). */
      readonly attempt: number;
      readonly state: RetryState;
    }
  | { readonly type: "fail"; readonly reason: string; readonly message: string }
  | { readonly type: "acknowledge" }
  /** D67: give up on a staging call: acknowledge with no plan, so the dock is the floor set. */
  | { readonly type: "floorSet"; readonly reason: string; readonly message: string };

/** Attempts made so far, counting the first call. */
export function attemptsMade(state: RetryState): number {
  return 1 + state.failures + state.budgetWaits;
}

export function nextRetryAction(state: RetryState, failure: NarratorFailure): RetryAction {
  switch (failure.kind) {
    case "spacing":
      return { type: "acknowledge" };
    case "fatal":
      return { type: "fail", reason: failure.reason, message: failure.message };
    case "budget": {
      const waited = state.budgetWaits * BUDGET_RETRY_DELAY_MS;
      if (waited + BUDGET_RETRY_DELAY_MS > BUDGET_RETRY_WINDOW_MS) {
        return { type: "fail", reason: failure.reason, message: failure.message };
      }
      const next = { ...state, budgetWaits: state.budgetWaits + 1 };
      return {
        type: "retry",
        delayMs: BUDGET_RETRY_DELAY_MS,
        attempt: attemptsMade(next),
        state: next,
      };
    }
    case "retryable": {
      const delayMs = RETRY_DELAYS_MS[state.failures];
      if (delayMs === undefined) {
        return { type: "fail", reason: failure.reason, message: failure.message };
      }
      const next = { ...state, failures: state.failures + 1 };
      return { type: "retry", delayMs, attempt: attemptsMade(next), state: next };
    }
    default:
      return { type: "fail", reason: failure.reason, message: failure.message };
  }
}

/**
 * D69: the staging call's own, short schedule. The sim is halted on it and it only dresses the
 * dock, so a blip gets two quick retries and anything longer gets the floor set; D43's schedule
 * (a minute of waits) froze the ship at the end of transit.
 */
export const STAGING_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000];

/**
 * D67 (D57's exception to D43): the staging call (`stageDock`) never ends on the error panel.
 * D69: it retries a transient failure on `STAGING_RETRY_DELAYS_MS`, and where that runs out, or
 * the failure is fatal or the hourly budget (which a story call waits out), the hook is
 * acknowledged with no plan and the dock is the sim's floor set: staging is not story.
 */
export function stagingRetryAction(state: RetryState, failure: NarratorFailure): RetryAction {
  if (failure.kind === "spacing") return { type: "acknowledge" };
  if (failure.kind === "retryable") {
    const delayMs = STAGING_RETRY_DELAYS_MS[state.failures];
    if (delayMs !== undefined) {
      const next = { ...state, failures: state.failures + 1 };
      return { type: "retry", delayMs, attempt: attemptsMade(next), state: next };
    }
  }
  return { type: "floorSet", reason: failure.reason, message: failure.message };
}

/** The Retry button: start the whole sequence over from attempt 1. */
export function resetRetry(): RetryState {
  return INITIAL_RETRY_STATE;
}
