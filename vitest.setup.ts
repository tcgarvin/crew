/**
 * Shared Vitest setup (slice-5 integration): let the event loop turn between tests.
 *
 * Vitest's worker reports progress over an RPC with a fixed 60 s timeout, and the runner starts
 * the next test without returning to the event loop. Several synchronous real-content tests in a
 * row (a full-sim file is four, 85 s together under the parallel suite) therefore hold the worker
 * past that minute, and the run fails with "Timeout calling onTaskUpdate" though every test
 * passed. A zero-delay timer after each test lets the worker answer the RPC; `setImmediate` does
 * not (measured: two 35 s tests still failed with it). A single test longer than a minute must
 * yield on its own (`apps/cli/src/yielding.ts`).
 */
import { afterEach } from "vitest";

afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
