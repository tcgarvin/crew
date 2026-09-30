import type { DecisionCardText } from "@crew/content";
import type { Decision } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { aftermathCaption } from "./aftermath";

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec1" as never,
    origin: "policy",
    perspectiveActorId: "a1" as never,
    prompt: { key: "job.offer", params: {} },
    left: { label: { key: "job.offer.accept", params: {} }, commands: [] },
    right: { label: { key: "job.offer.decline", params: {} }, commands: [] },
    status: "pending",
    createdTick: 0,
    ...overrides,
  };
}

const card: DecisionCardText = {
  decisionId: "dec1",
  title: "A job offer",
  situation: "…",
  leftLabel: "Take it",
  rightLabel: "Pass",
};

describe("aftermathCaption", () => {
  it("falls back to the built-in job-offer lines", () => {
    expect(aftermathCaption(decision(), "left", undefined)).toMatch(/^Taken\./);
    expect(aftermathCaption(decision(), "right", undefined)).toMatch(/^You pass\./);
  });

  it("prefers the option's own aftermath prose", () => {
    const d = decision({
      right: {
        label: { key: "job.offer.decline", params: {} },
        commands: [],
        aftermath: { key: "job.offer.declined", params: {}, prose: "She shrugs and moves on." },
      },
    });
    expect(aftermathCaption(d, "right", undefined)).toBe("She shrugs and moves on.");
  });

  it("prefers the narrator card's aftermath over everything", () => {
    const narrated = { ...card, leftAftermath: "Hands to the hold." };
    expect(aftermathCaption(decision(), "left", narrated)).toBe("Hands to the hold.");
    // Blank narrator text is ignored.
    expect(aftermathCaption(decision(), "left", { ...card, leftAftermath: " " } as never)).toMatch(
      /^Taken\./,
    );
  });

  it("uses a generic line for other decisions", () => {
    const d = decision({ prompt: { key: "narrator.decision", params: {} } });
    expect(aftermathCaption(d, "left", card)).toBe("Decided. The crew get on with it.");
  });
});
