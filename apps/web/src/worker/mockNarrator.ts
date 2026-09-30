/**
 * Stand-in for the real narrator round trip (server call to the LLM, D5). Fakes ~2s of latency,
 * matching the task brief, then returns a `surfaceDecision` command carrying a mock decision
 * card. Kept separate from `mockKernel.ts` so `host.ts`'s `Narrator` dependency is easy to see as
 * the seam that gets replaced (a `fetch` to `packages/server`'s narrator route) when W8/W9 land.
 */
import type { Command, CommandId, DecisionCardSpec, NarratorHook } from "@crew/sim";

const FAKE_LATENCY_MS = 2000;

let counter = 0;
function nextCommandId(): CommandId {
  counter += 1;
  return `cmd:narrator:mock:${counter}` as CommandId;
}

export async function mockNarrator(
  _hook: NarratorHook,
  buildCard: () => DecisionCardSpec,
): Promise<{ commands: readonly Command[] }> {
  await new Promise((resolve) => setTimeout(resolve, FAKE_LATENCY_MS));
  const command: Command = {
    id: nextCommandId(),
    source: "narrator",
    kind: "surfaceDecision",
    payload: { card: buildCard() },
  };
  return { commands: [command] };
}
