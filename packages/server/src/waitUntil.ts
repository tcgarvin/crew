/**
 * `waitUntil` from `@vercel/functions`, used opportunistically. This package does not depend on
 * `@vercel/functions` (it isn't installed in this workspace and the narrator route must work
 * without it locally and in tests) — we probe for it at runtime via dynamic import and fall back
 * to just awaiting the work inline when it isn't present or there's no request context to extend.
 */

type WaitUntilFn = (promise: Promise<unknown>) => void;

let cachedWaitUntil: WaitUntilFn | null | undefined;

async function resolveWaitUntil(): Promise<WaitUntilFn | null> {
  if (cachedWaitUntil !== undefined) return cachedWaitUntil;
  try {
    // Dynamic + a non-literal-looking specifier so bundlers don't try to resolve this at build
    // time when the package isn't installed.
    const specifier = "@vercel/functions";
    const mod = (await import(/* @vite-ignore */ specifier)) as { waitUntil?: WaitUntilFn };
    cachedWaitUntil = typeof mod.waitUntil === "function" ? mod.waitUntil : null;
  } catch {
    cachedWaitUntil = null;
  }
  return cachedWaitUntil;
}

/**
 * Runs `work` so it can finish after the response is sent when a Vercel request context is
 * available (via `@vercel/functions`'s `waitUntil`), otherwise just awaits it inline. Errors are
 * swallowed here; callers that care should catch inside `work`.
 */
export async function runAfterResponse(work: () => Promise<void>): Promise<void> {
  const waitUntil = await resolveWaitUntil();
  if (waitUntil) {
    try {
      waitUntil(work());
      return;
    } catch {
      // `waitUntil` throws outside a Vercel request context; fall through to inline execution.
    }
  }
  await work().catch(() => {});
}
