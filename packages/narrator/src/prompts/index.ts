/**
 * Prompt assembly. The system prompt is two blocks, both cache breakpoints:
 *  1. `STATIC_RULES`: principles plus every hook's instructions. Byte-identical for every call
 *     of every game, so one cache entry serves them all.
 *  2. The game's capability list (ports, cargo, the ship's machine instance IDs such as `m2`).
 *     Nearly fixed for a game (the port markets and each port's distance "from here" move with
 *     the ship), so it caches across a run of calls; it is placed after the static rules so a
 *     new game never invalidates them.
 * Everything that changes between calls (tick, digest, notes, which hook) is in the user turn,
 * after both breakpoints.
 */
import type { NarratorHookKind } from "@crew/sim";
import type { NarratorDigest } from "../digest";
import { HOOK_INSTRUCTIONS } from "./hooks";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./system";

export { HOOK_INSTRUCTIONS } from "./hooks";
export { PROMPT_VERSION, SYSTEM_PROMPT } from "./system";

const HOOK_ORDER: readonly NarratorHookKind[] = [
  "approachingPort",
  "jobBoard",
  "quietTooLong",
  "notableEvent",
  "policyDecision",
];

/** The static prefix: `SYSTEM_PROMPT` plus the instructions for every hook, in a fixed order. */
export const STATIC_RULES = `${SYSTEM_PROMPT}

# When you are called

${HOOK_ORDER.map((kind) => `- ${kind}: ${HOOK_INSTRUCTIONS[kind]}`).join("\n")}`;

export interface NarratorPrompt {
  readonly promptVersion: string;
  /**
   * System blocks in order; every block is static for the game and carries a cache breakpoint
   * (the transport marks each one).
   */
  readonly system: readonly string[];
  readonly user: string;
}

export function buildPrompt(
  capabilities: string,
  digest: NarratorDigest,
  hookKind: NarratorHookKind,
): NarratorPrompt {
  return {
    promptVersion: PROMPT_VERSION,
    system: [STATIC_RULES, capabilities],
    user: `# The ship right now\n\n${digest.text}\n\n# This call: ${hookKind}\n\n${HOOK_INSTRUCTIONS[hookKind]}`,
  };
}
