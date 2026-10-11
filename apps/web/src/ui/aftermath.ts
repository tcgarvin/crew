/**
 * §aftermath-caption: the one line shown for a moment after the player picks a side, saying plainly
 * what happens next. Narrator prose wins, then the option's own `aftermath` (its prose, else its
 * template as the card reads it), then a built-in line for job offers, then a generic line.
 */
import { type DecisionCardText, templateCard } from "@crew/content";
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
 * alongside the aftermath caption). Read structurally so this works whether or not the field has
 * landed.
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
  if (decision[side].aftermath !== undefined) {
    // The template card, not the bare key: an offer's sides keep the freight keys, and the card
    // reads an errand or a passage from the prompt's params (expeditions A2, passengers §6), so an
    // errand taken never says the crew start loading.
    const card = templateCard(decision, content);
    const text = side === "left" ? card.leftAftermath : card.rightAftermath;
    if (text !== undefined && text.trim() !== "") return text;
  }
  if (decision.prompt.key === "job.offer") return JOB_OFFER_AFTERMATH[side];
  return GENERIC_AFTERMATH;
}
