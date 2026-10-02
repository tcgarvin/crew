/**
 * Per-hook instructions. All of them sit in the static, cached system prefix (so the prefix is
 * the same for every hook); the one for this call is repeated after the digest.
 */
import type { NarratorHookKind } from "@crew/sim";

export const HOOK_INSTRUCTIONS: Readonly<Record<NarratorHookKind, string>> = {
  approachingPort:
    'The ship is about to dock. You are the only source of work: if you offer nothing, there is no work at this port until the next call. Offer one or two jobs from this port (offerJob with fromPort set to it); routes and cargo must come from the capability list. Each offer comes from a named person with a pitch in their own voice; if someone under "People you know here" fits, bring them back rather than inventing someone new. You may surface one of them as the captain\'s card (surface=true) if it carries a hook or a complication worth a decision; it is shown once the ship has docked. Otherwise post it quietly. Offering nothing must be a deliberate story choice (say why in rationale) and should be rare. You may also stage cargo in a port store with spawnAtBoundary if it sets up a thread. Card is null.',
  jobBoard:
    "The ship is docked and the captain is looking for work; nothing is on offer here. You are the only source of work: if you offer nothing, there is no work at this port until the next call, so offering nothing must be a deliberate story choice (say why in rationale) and should be rare. Usually answer with an offer from someone who fits this port and your threads: one or two jobs from this port (offerJob with fromPort set to it), as for an arrival, each from a named person with a pitch, people you know here first. At most one surfaced card. Card is null.",
  quietTooLong:
    'Nothing story-worthy has happened for a while. This is a check-in, not a request: read the Pacing rules, "What the captain has seen" and the ship\'s state, and decide whether the story needs forward motion, a breath, or nothing. What is available to you: offer work (one or two offerJob from this port, each from a named person with a pitch, people you know here first) when the captain is idle at a port; advance a thread whose nextBeat is true (a surfaceDecision from one of its people, or a beat card if it has had none); a minor crew card showing someone the captain has not seen on a card, in their own words (speaker set to their name); scheduleFault when the story needs pressure, never right after another fault; stockMarket when a stalled repair should find its part here or at the next port; or nothing. Say which you chose and why in rationale. Never a variation on a recent card. Card is null.',
  notableEvent:
    "Something notable just happened (see the hook line and recent events). Update your notes to reflect it. Add an intent only if the event genuinely invites one, for example a decision it raises for the captain. Card is null.",
  policyDecision:
    "The crew need the captain to decide something the kernel has already put on a card (see pending decisions). Do not add intents that create new cards. Write `card` for that decision: a title, the speaker (the person bringing it, by full name, or empty for an observed scene), the situation as that person says it to the captain (never more than 70 words, no numbers, nothing [undiscovered]), the two side labels (what the captain says or does) in the same order as the decision's left and right, and leftAftermath/rightAftermath: what happens next on each side, one plain sentence of at most 20 words, no numbers.",
};
