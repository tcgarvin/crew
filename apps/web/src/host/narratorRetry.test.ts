import { describe, expect, it } from "vitest";
import type { NarratorFailure } from "./narrator";
import {
  INITIAL_RETRY_STATE,
  RETRY_DELAYS_MS,
  type RetryAction,
  type RetryState,
  STAGING_RETRY_DELAYS_MS,
  nextRetryAction,
  resetRetry,
  stagingRetryAction,
} from "./narratorRetry";

const timeout: NarratorFailure = { kind: "retryable", reason: "timeout", message: "timed out" };
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
    expect(nextRetryAction({ failures: 3 }, spacing)).toEqual({
      type: "acknowledge",
    });
  });

  it("resets to attempt 1 so the Retry button restarts the whole sequence", () => {
    const exhausted = drain(timeout);
    expect(exhausted.at(-1)?.type).toBe("fail");
    const fresh = nextRetryAction(resetRetry(), timeout);
    expect(fresh).toMatchObject({ type: "retry", delayMs: 2_000, attempt: 2 });
    expect(resetRetry()).toEqual(INITIAL_RETRY_STATE);
  });
});

describe("stagingRetryAction (D67, D69)", () => {
  it("retries a staging call twice, quickly, then falls back to the floor set, never the panel", () => {
    // D69: the sim is halted on the call, so D43's minute-long schedule froze the ship in
    // transit (27 s in the playthrough with fast failures); staging is dressing, not story.
    const actions: RetryAction[] = [];
    let state = INITIAL_RETRY_STATE;
    for (let i = 0; i < 100; i += 1) {
      const action = stagingRetryAction(state, timeout);
      actions.push(action);
      if (action.type !== "retry") break;
      state = action.state;
    }
    const retries = actions.filter((a) => a.type === "retry");
    expect(retries.map((a) => a.delayMs)).toEqual([...STAGING_RETRY_DELAYS_MS]);
    expect(STAGING_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6_000);
    expect(actions.at(-1)).toEqual({ type: "floorSet", reason: "timeout", message: "timed out" });
    expect(actions.some((a) => a.type === "fail")).toBe(false);
  });

  it("falls back at once where a story call would fail at once, and still honours spacing", () => {
    expect(stagingRetryAction(INITIAL_RETRY_STATE, notConfigured)).toEqual({
      type: "floorSet",
      reason: "notConfigured",
      message: "no key",
    });
    expect(stagingRetryAction(INITIAL_RETRY_STATE, spacing)).toEqual({ type: "acknowledge" });
  });
});
