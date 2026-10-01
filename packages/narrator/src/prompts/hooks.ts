/**
 * Per-hook instructions. All of them sit in the static, cached system prefix (so the prefix is
 * the same for every hook); the one for this call is repeated after the digest.
 */
import type { NarratorHookKind } from "@crew/sim";

export const HOOK_INSTRUCTIONS: Readonly<Record<NarratorHookKind, string>> = {
  approachingPort:
    'The ship is about to dock. Offer one or two jobs from this port (offerJob with fromPort set to it); routes and cargo must come from the capability list. Each offer comes from a named person with a pitch in their own voice; if someone under "People you know here" fits, bring them back rather than inventing someone new. You may surface one of them as the captain\'s card (surface=true) if it carries a hook or a complication worth a decision; otherwise post it quietly. You may also stage cargo in a port store with spawnAtBoundary if it sets up a thread. Card is null.',
  jobBoard:
    "The ship is docked and the port board is empty. Offer one or two jobs from this port (offerJob with fromPort set to it), as for an arrival: a named person, a pitch, and people you know here first. At most one surfaced card. Card is null.",
  quietTooLong:
    "Nothing story-worthy has happened for a while. Choose one: schedule a fault on a machine that has none pending (scheduleFault, pick a window), or a small low-stakes surfaceDecision about ship life, brought by a crew member in their own words (speaker set to their name), or deliberately nothing if the ship already has enough going on (say why in rationale and notes). Card is null.",
  notableEvent:
    "Something notable just happened (see the hook line and recent events). Update your notes to reflect it. Add an intent only if the event genuinely invites one, for example a decision it raises for the captain. Card is null.",
  policyDecision:
    "The crew need the captain to decide something the kernel has already put on a card (see pending decisions). Do not add intents that create new cards. Write `card` for that decision: a title, the speaker (the person bringing it, by full name, or null for an observed scene), the situation as that person says it to the captain (never more than 70 words, no numbers, nothing [undiscovered]), the two side labels (what the captain says or does) in the same order as the decision's left and right, and leftAftermath/rightAftermath: what happens next on each side, one plain sentence of at most 20 words, no numbers.",
};
