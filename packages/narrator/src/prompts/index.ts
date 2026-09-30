/**
 * Prompt assembly: a cached static prefix (principles, then this game's capability list) and a
 * dynamic user turn (digest, then the hook instruction).
 */
import type { NarratorHookKind } from "@crew/sim";
import type { NarratorDigest } from "../digest";
import { HOOK_INSTRUCTIONS } from "./hooks";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./system";

export { HOOK_INSTRUCTIONS } from "./hooks";
export { PROMPT_VERSION, SYSTEM_PROMPT } from "./system";

export interface NarratorPrompt {
  readonly promptVersion: string;
  /** System blocks in order; the last one carries the cache breakpoint. */
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
    system: [SYSTEM_PROMPT, capabilities],
    user: `# The ship right now\n\n${digest.text}\n\n# This call\n\n${HOOK_INSTRUCTIONS[hookKind]}`,
  };
}
