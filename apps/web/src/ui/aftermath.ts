/**
 * D26 aftermath caption: the one line shown for a moment after the player picks a side, saying
 * plainly what happens next. Narrator prose wins, then the option's own `aftermath`, then a
 * built-in line for job offers, then a generic line.
 */
import { type DecisionCardText, renderTextRef } from "@crew/content";
import type { ContentBundle, Decision, DeepReadonly } from "@crew/sim";

/** How long the card stays up with the caption before it closes. */
export const AFTERMATH_MS = 2_500;

/** Built-in lines for the one decision kind V1 has, used when neither prose nor data has one. */
const JOB_OFFER_AFTERMATH: Readonly<Record<"left" | "right", string>> = {
  left: "Taken. The crew start loading — we leave once the hold is full.",
  right: "You pass. Word gets around the board; another offer usually turns up.",
};

const GENERIC_AFTERMATH = "Decided. The crew get on with it.";

/**
 * The narrator's card may carry `leftAftermath`/`rightAftermath` (added by the narrator package
 * alongside D26). Read structurally so this works whether or not the field has landed.
 */
function narratorAftermath(
  card: DecisionCardText | undefined,
  side: "left" | "right",
): string | undefined {
  if (card === undefined) return undefined;
  const value: unknown = (card as unknown as Record<string, unknown>)[`${side}Aftermath`];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function aftermathCaption(
  decision: DeepReadonly<Decision>,
  side: "left" | "right",
  narratorCard: DecisionCardText | undefined,
  content?: ContentBundle,
): string {
  const fromNarrator = narratorAftermath(narratorCard, side);
  if (fromNarrator !== undefined) return fromNarrator;
  const ref = decision[side].aftermath;
  if (ref !== undefined) {
    const text = ref.prose ?? renderTextRef(ref, content);
    if (text.trim() !== "") return text;
  }
  if (decision.prompt.key === "job.offer") return JOB_OFFER_AFTERMATH[side];
  return GENERIC_AFTERMATH;
}
