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

  /** An offer card as `surfaceOfferCard` writes it: the freight keys on both sides. */
  const offer = (params: Record<string, string>) =>
    decision({
      prompt: { key: "job.offer", params },
      left: {
        label: { key: "job.offer.accept", params: {} },
        commands: [],
        aftermath: { key: "job.accept.aftermath", params: {} },
      },
      right: {
        label: { key: "job.offer.decline", params: {} },
        commands: [],
        aftermath: { key: "job.decline.aftermath", params: {} },
      },
    });

  it("reads a freight offer's own aftermath as freight", () => {
    const freight = offer({ name: "Hal Petrosyan", cargo: "item.crate_general" });
    expect(aftermathCaption(freight, "left", undefined)).toMatch(/start loading/);
    expect(aftermathCaption(freight, "right", undefined)).toMatch(/^You pass\./);
  });

  it("never says the crew start loading for an errand (expeditions A2)", () => {
    const errand = offer({
      name: "Ysolde Maren",
      errand: "fetchPerson",
      target: "Teodor Lusk",
      site: "port.harrow_end",
      wants: "alive",
    });
    const taken = aftermathCaption(errand, "left", undefined);
    expect(taken).toBe("Taken. We set a course for the site and see what's waiting there.");
    expect(taken).not.toMatch(/loading|hold/);
    expect(aftermathCaption(errand, "right", undefined)).toBe(
      "You pass. They'll find someone else to send.",
    );
    // §cards-never-mention-pay: nothing on either side is a number.
    expect(`${taken} ${aftermathCaption(errand, "right", undefined)}`).not.toMatch(/\d/);
  });

  it("reads a passage offer's aftermath as a person coming aboard (passengers §6)", () => {
    const passage = offer({ name: "Halla Thorne", passenger: "true", roundTrip: "false" });
    expect(aftermathCaption(passage, "left", undefined)).toMatch(/come up the ramp/);
    expect(aftermathCaption(passage, "right", undefined)).toMatch(/another ship/);
  });

  it("keeps the narrator's and the side's own prose ahead of an errand's template", () => {
    const errand = offer({ errand: "fetchPerson", target: "Teodor Lusk", wants: "alive" });
    expect(aftermathCaption(errand, "left", { ...card, leftAftermath: "Off we go." })).toBe(
      "Off we go.",
    );
    const withProse = {
      ...errand,
      left: {
        ...errand.left,
        aftermath: { key: "job.accept.aftermath", params: {}, prose: "Go." },
      },
    };
    expect(aftermathCaption(withProse, "left", undefined)).toBe("Go.");
  });

  it("uses a generic line for other decisions", () => {
    const d = decision({ prompt: { key: "narrator.decision", params: {} } });
    expect(aftermathCaption(d, "left", card)).toBe("Decided. The crew get on with it.");
  });
});
