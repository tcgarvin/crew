/**
 * Expeditions A1 (§8.6): the inspector's body line for a person: "unhurt", "stunned", "wounded:
 * right leg (serious), bleeding", "down — wounded: torso (grave), bleeding", "dead". Read from their
 * own body in the agent view (`SelfView.body`).
 */
import type { BodyPart, BodyView } from "@crew/sim";

const PART_WORDS: Readonly<Record<BodyPart, string>> = {
  head: "head",
  torso: "torso",
  leftArm: "left arm",
  rightArm: "right arm",
  leftLeg: "left leg",
  rightLeg: "right leg",
};

export function bodyLine(body: Pick<BodyView, "wounds" | "stunned" | "availability">): string {
  if (body.availability === "dead") return "dead";
  const parts: string[] = [];
  if (body.wounds.length > 0) {
    const hurts = body.wounds.map((w) => `${PART_WORDS[w.part]} (${w.severity})`);
    const bleeding = body.wounds.some((w) => w.bleeding);
    parts.push(`wounded: ${hurts.join(", ")}${bleeding ? ", bleeding" : ""}`);
  }
  if (body.stunned) parts.push("stunned");
  const state = parts.length === 0 ? "unhurt" : parts.join("; ");
  return body.availability === "incapacitated" ? `down — ${state}` : state;
}
