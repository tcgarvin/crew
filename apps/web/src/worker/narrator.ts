/**
 * Narrator seam stub (Integration 1, task item 6). The real server round trip is W9's; until
 * then this resolves with no commands after a fixed delay so `host.ts`'s existing hook flow
 * (post `hookRaised`, await the narrator, enqueue `acknowledgeHook`) exercises the real kernel's
 * quiet-too-long timer end to end.
 */
import type { Command, NarratorHook } from "@crew/sim";

const STUB_LATENCY_MS = 1500;

export async function stubNarrator(
  _hook: NarratorHook,
): Promise<{ readonly commands: readonly Command[] }> {
  await new Promise((resolve) => setTimeout(resolve, STUB_LATENCY_MS));
  return { commands: [] };
}
