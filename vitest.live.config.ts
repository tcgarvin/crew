/**
 * Live narrator tests (D44): real OpenRouter calls, one per hook kind. Not part of `pnpm test`;
 * run `pnpm test:live` by hand before deploying prompt, schema or transport changes. Files run
 * one at a time and tests in order, to stay inside OpenRouter's rate limits.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "live",
    environment: "node",
    include: ["packages/narrator/src/live/**/*.live.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
  },
});
