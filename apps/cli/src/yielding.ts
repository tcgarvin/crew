/**
 * Long headless runs as generators that yield between chunks of work (slice-5 integration).
 *
 * A day of the real ship is tens of seconds of synchronous CPU, longer under the full parallel
 * `pnpm test`. Vitest's worker reports progress over an RPC with a fixed 60 s timeout, and a test
 * that holds the thread past it fails the whole run ("Timeout calling onTaskUpdate") even though
 * every assertion passed. The runs therefore yield every so often: the CLI drains them at once
 * (`drain`), the tests let the event loop breathe between chunks (`drainAsync`). The result is the
 * same either way; only where the waiting happens differs.
 */

/** A run that yields (nothing) between chunks and returns its result. */
export type ChunkedRun<T> = Generator<void, T, void>;

/** Run to the end without stopping. */
export function drain<T>(run: ChunkedRun<T>): T {
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
  }
}

/** Run to the end, letting the event loop run between chunks. */
export async function drainAsync<T>(run: ChunkedRun<T>): Promise<T> {
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
