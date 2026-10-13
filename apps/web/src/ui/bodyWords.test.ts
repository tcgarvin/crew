/** Expeditions A1 (§8.6): the inspector's body line. */
import type { BodyView, WoundView } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { bodyLine } from "./bodyWords";

type BodyWords = Pick<BodyView, "wounds" | "stunned" | "availability">;

function wound(
  part: WoundView["part"],
  severity: WoundView["severity"],
  bleeding = false,
  treated = false,
): WoundView {
  return { part, severity, bleeding, treated };
}

const body = (wounds: WoundView[], over: Partial<Omit<BodyWords, "wounds">> = {}): BodyWords => ({
  wounds,
  stunned: false,
  availability: "available",
  ...over,
});

describe("bodyLine", () => {
  it("reads unhurt with no wound and no stun", () => {
    expect(bodyLine(body([]))).toBe("unhurt");
  });

  it("names each wound's part and severity, and says bleeding", () => {
    expect(bodyLine(body([wound("rightLeg", "serious", true)]))).toBe(
      "wounded: right leg (serious), bleeding",
    );
    expect(bodyLine(body([wound("leftArm", "graze"), wound("torso", "serious")]))).toBe(
      "wounded: left arm (graze), torso (serious)",
    );
  });

  it("says treated once every wound is treated at the medbay bed (§treatment-at-the-medbay-bed)", () => {
    expect(bodyLine(body([wound("rightLeg", "serious", false, true)]))).toBe(
      "wounded: right leg (serious), treated",
    );
    expect(
      bodyLine(body([wound("rightLeg", "serious", false, true), wound("head", "graze")])),
    ).toBe("wounded: right leg (serious), head (graze)");
  });

  it("reads stunned from the view's flag", () => {
    expect(bodyLine(body([], { stunned: true }))).toBe("stunned");
  });

  it("says down for the incapacitated and dead for the dead", () => {
    const down = { availability: "incapacitated" } as const;
    expect(bodyLine(body([wound("torso", "grave", true)], down))).toBe(
      "down — wounded: torso (grave), bleeding",
    );
    expect(bodyLine(body([], { ...down, stunned: true }))).toBe("down — stunned");
    expect(bodyLine(body([wound("head", "grave")], { availability: "dead" }))).toBe("dead");
  });
});
