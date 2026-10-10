/**
 * Expeditions A1 (§8.6): the inspector's body line for a person: "unhurt", "stunned", "wounded:
 * right leg (serious), bleeding", "down — wounded: torso (grave), bleeding", "dead". Read from the
 * actor's body in the snapshot at the view tick (the agent view carries only whether a wound is
 * open and bleeds, not where).
 */
import type { Availability, Body, BodyPart } from "@crew/sim";

const PART_WORDS: Readonly<Record<BodyPart, string>> = {
  head: "head",
  torso: "torso",
  leftArm: "left arm",
  rightArm: "right arm",
  leftLeg: "left leg",
  rightLeg: "right leg",
};

/**
 * Stun (consciousness debt) above which they read as stunned; it decays slowly, so a trace left
 * minutes after the hit is not worth a word.
 */
export const STUNNED_ABOVE = 0.05;

export function bodyLine(body: Pick<Body, "wounds" | "stun">, availability: Availability): string {
  if (availability === "dead") return "dead";
  const hurts = body.wounds
    .filter((w) => w.type !== "stun")
    .map((w) => `${PART_WORDS[w.part]} (${w.severity})`);
  const parts: string[] = [];
  if (hurts.length > 0) {
    const bleeding = body.wounds.some((w) => w.bleeding);
    parts.push(`wounded: ${hurts.join(", ")}${bleeding ? ", bleeding" : ""}`);
  }
  if (body.stun > STUNNED_ABOVE) parts.push("stunned");
  const state = parts.length === 0 ? "unhurt" : parts.join("; ");
  return availability === "incapacitated" ? `down — ${state}` : state;
}
