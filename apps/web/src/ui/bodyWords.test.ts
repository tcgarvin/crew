/** Expeditions A1 (§8.6): the inspector's body line. */
import type { Body, Tick, Wound, WoundId } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { STUNNED_ABOVE, bodyLine } from "./bodyWords";

function wound(part: Wound["part"], severity: Wound["severity"], over: Partial<Wound> = {}): Wound {
  return {
    id: `w${part}` as WoundId,
    part,
    severity,
    type: "blaster",
    bleeding: false,
    tick: 0 as Tick,
    ...over,
  };
}

const body = (wounds: Wound[], stun = 0): Pick<Body, "wounds" | "stun"> => ({ wounds, stun });

describe("bodyLine", () => {
  it("reads unhurt with no wound and no stun", () => {
    expect(bodyLine(body([]), "available")).toBe("unhurt");
  });

  it("names each wound's part and severity, and says bleeding", () => {
    expect(bodyLine(body([wound("rightLeg", "serious", { bleeding: true })]), "available")).toBe(
      "wounded: right leg (serious), bleeding",
    );
    expect(
      bodyLine(body([wound("leftArm", "graze"), wound("torso", "serious")]), "available"),
    ).toBe("wounded: left arm (graze), torso (serious)");
  });

  it("reads stunned from the stun debt, not from the stun hit's wound", () => {
    const stunHit = wound("leftArm", "graze", { type: "stun" });
    expect(bodyLine(body([stunHit], STUNNED_ABOVE + 0.4), "available")).toBe("stunned");
    expect(bodyLine(body([stunHit], STUNNED_ABOVE / 2), "available")).toBe("unhurt");
  });

  it("says down for the incapacitated and dead for the dead", () => {
    expect(bodyLine(body([wound("torso", "grave", { bleeding: true })]), "incapacitated")).toBe(
      "down — wounded: torso (grave), bleeding",
    );
    expect(bodyLine(body([], 0.9), "incapacitated")).toBe("down — stunned");
    expect(bodyLine(body([wound("head", "grave")]), "dead")).toBe("dead");
  });
});
