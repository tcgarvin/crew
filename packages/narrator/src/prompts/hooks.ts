/**
 * Per-hook instructions, appended after the digest (the dynamic part of the prompt).
 */
import type { NarratorHookKind } from "@crew/sim";

export const HOOK_INSTRUCTIONS: Readonly<Record<NarratorHookKind, string>> = {
  approachingPort:
    "The ship is about to dock. Offer one or two jobs from this port (offerJob with fromPort set to it) with a named issuer and a line of flavour; routes and cargo must come from the capability list. You may surface one of them as the captain's card (surface=true) if it carries a hook or a complication worth a decision; otherwise post it quietly. You may also stage cargo in a port store with spawnAtBoundary if it sets up a thread. Card is null.",
  jobBoard:
    "The ship is docked and the port board is empty. Offer one or two jobs from this port (offerJob with fromPort set to it), as for an arrival. At most one surfaced card. Card is null.",
  quietTooLong:
    "Nothing story-worthy has happened for a while. Choose one: schedule a fault on a machine that has none pending (scheduleFault, pick a window), or a small low-stakes surfaceDecision about ship life, or deliberately nothing if the ship already has enough going on (say why in rationale and notes). Card is null.",
  notableEvent:
    "Something notable just happened (see the hook line and recent events). Update your notes to reflect it. Add an intent only if the event genuinely invites one, for example a decision it raises for the captain. Card is null.",
  policyDecision:
    "The crew need the captain to decide something the kernel has already put on a card (see pending decisions). Do not add intents that create new cards. Write `card` for that decision: a title, the situation from the captain's point of view (at most 60 words, no numbers, nothing [undiscovered]), and the two side labels in the same order as the decision's left and right.",
};
