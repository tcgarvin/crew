/**
 * Work that may finish after the response is sent. On Vercel, `waitUntil` keeps the function
 * alive for it; anywhere else (local dev, tests) it is awaited inline, so it has finished when the
 * caller continues.
 *
 * D97: `@vercel/functions` was once probed for at runtime with a dynamic import it could never
 * resolve (it was not installed and the bundle had no copy), so every "after response" job ran
 * inline in production too. It is now a dependency, imported statically so the bundle has it.
 */
import { waitUntil } from "@vercel/functions";

/**
 * Runs `work` after the response when `onVercel` (`Env.onVercel`), otherwise awaits it inline.
 * Errors are swallowed here; callers that care should catch inside `work`.
 */
export async function runAfterResponse(
  work: () => Promise<void>,
  onVercel: boolean,
): Promise<void> {
  const pending = work().catch(() => {});
  if (onVercel) {
    waitUntil(pending);
    return;
  }
  await pending;
}
