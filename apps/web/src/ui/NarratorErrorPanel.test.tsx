import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NarratorFailure } from "../host/narrator";
import { INITIAL_RETRY_STATE, nextRetryAction, resetRetry } from "../host/narratorRetry";
import { NarratorErrorPanel, narratorReasonText } from "./NarratorErrorPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("NarratorErrorPanel (D43)", () => {
  it("renders the title, the reason in plain words, the raw message and only a Retry", () => {
    const html = renderToStaticMarkup(
      <NarratorErrorPanel reason="timeout" message="narrator call timed out" onRetry={() => {}} />,
    );
    expect(html).toContain("The narrator is unavailable");
    expect(html).toContain("The model did not answer in time");
    expect(html).toContain("narrator call timed out");
    expect(html).toContain(">Retry<");
    expect(html).not.toMatch(/without/i);
  });

  it("maps every failure code to plain words", () => {
    expect(narratorReasonText("notConfigured")).toBe("No narrator is configured for this server");
    expect(narratorReasonText("apiError")).toBe("The model service returned an error");
    expect(narratorReasonText("timeout")).toBe("The model did not answer in time");
    for (const code of ["truncated", "schemaInvalid", "refusal"]) {
      expect(narratorReasonText(code)).toBe("The model's answer could not be used");
    }
    expect(narratorReasonText("network")).toBe("Could not reach the server");
  });

  it("Retry restarts the backoff sequence from attempt 1", () => {
    // The sequence that led to the panel: every model retry used up.
    const timeout: NarratorFailure = { kind: "retryable", reason: "timeout", message: "t" };
    let state = INITIAL_RETRY_STATE;
    let action = nextRetryAction(state, timeout);
    while (action.type === "retry") {
      state = action.state;
      action = nextRetryAction(state, timeout);
    }
    expect(action.type).toBe("fail");

    // The host's Retry handler: reset the scheduler and call again.
    const onRetry = () => {
      state = resetRetry();
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<NarratorErrorPanel reason="timeout" message="t" onRetry={onRetry} />);
    });
    const button = container.querySelector("button.narrator-error-retry");
    if (!(button instanceof HTMLButtonElement)) throw new Error("no Retry button");
    act(() => {
      button.click();
    });
    expect(state).toEqual(INITIAL_RETRY_STATE);
    expect(nextRetryAction(state, timeout)).toMatchObject({
      type: "retry",
      delayMs: 2_000,
      attempt: 2,
    });
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
