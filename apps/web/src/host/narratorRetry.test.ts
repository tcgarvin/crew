import { describe, expect, it } from "vitest";
import type { NarratorFailure } from "./narrator";
import {
  BUDGET_RETRY_DELAY_MS,
  BUDGET_RETRY_WINDOW_MS,
  INITIAL_RETRY_STATE,
  RETRY_DELAYS_MS,
  type RetryAction,
  type RetryState,
  nextRetryAction,
  resetRetry,
} from "./narratorRetry";

const timeout: NarratorFailure = { kind: "retryable", reason: "timeout", message: "timed out" };
const budget: NarratorFailure = { kind: "budget", reason: "budget", message: "cap" };
const notConfigured: NarratorFailure = {
  kind: "fatal",
  reason: "notConfigured",
  message: "no key",
};
const spacing: NarratorFailure = { kind: "spacing", reason: "spacing", message: "too soon" };

/** Drive the machine through repeated failures until it stops retrying. */
function drain(failure: NarratorFailure, start: RetryState = INITIAL_RETRY_STATE) {
  const actions: RetryAction[] = [];
  let state = start;
  for (let i = 0; i < 100; i += 1) {
    const action = nextRetryAction(state, failure);
    actions.push(action);
    if (action.type !== "retry") break;
    state = action.state;
  }
  return actions;
}

describe("nextRetryAction (D43)", () => {
  it("backs off 2, 4, 8, 16, 30 s through retryable failures, then fails", () => {
    const actions = drain(timeout);
    const retries = actions.filter((a) => a.type === "retry");
    expect(retries.map((a) => a.delayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(retries.map((a) => a.attempt)).toEqual([2, 3, 4, 5, 6]);
    expect(retries.reduce((sum, a) => sum + a.delayMs, 0)).toBe(60_000);
    expect(actions.at(-1)).toEqual({ type: "fail", reason: "timeout", message: "timed out" });
    expect(RETRY_DELAYS_MS).toHaveLength(5);
  });

  it("fails at once on a fatal failure", () => {
    expect(nextRetryAction(INITIAL_RETRY_STATE, notConfigured)).toEqual({
      type: "fail",
      reason: "notConfigured",
      message: "no key",
    });
  });

  it("acknowledges the hook without an answer on the spacing rule only", () => {
    expect(nextRetryAction(INITIAL_RETRY_STATE, spacing)).toEqual({ type: "acknowledge" });
    expect(nextRetryAction({ failures: 3, budgetWaits: 0 }, spacing)).toEqual({
      type: "acknowledge",
    });
  });

  it("waits out the hourly budget in 30 s steps for up to 5 minutes, then fails", () => {
    const actions = drain(budget);
    const retries = actions.filter((a) => a.type === "retry");
    expect(retries).toHaveLength(BUDGET_RETRY_WINDOW_MS / BUDGET_RETRY_DELAY_MS);
    expect(retries.every((a) => a.delayMs === 30_000)).toBe(true);
    expect(actions.at(-1)).toEqual({ type: "fail", reason: "budget", message: "cap" });
  });

  it("keeps budget waits and model retries on separate counters", () => {
    const afterBudget = nextRetryAction(INITIAL_RETRY_STATE, budget);
    if (afterBudget.type !== "retry") throw new Error("expected a retry");
    const afterTimeout = nextRetryAction(afterBudget.state, timeout);
    expect(afterTimeout).toMatchObject({ type: "retry", delayMs: 2_000, attempt: 3 });
  });

  it("resets to attempt 1 so the Retry button restarts the whole sequence", () => {
    const exhausted = drain(timeout);
    expect(exhausted.at(-1)?.type).toBe("fail");
    const fresh = nextRetryAction(resetRetry(), timeout);
    expect(fresh).toMatchObject({ type: "retry", delayMs: 2_000, attempt: 2 });
    expect(resetRetry()).toEqual(INITIAL_RETRY_STATE);
  });
});
