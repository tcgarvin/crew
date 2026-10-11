import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// CI runs only the unit tests (`pnpm test:unit`), so it takes every core. Locally the deep
// real-content sims (`*.deep.test.ts`) run too: CPU- and memory-heavy and synchronous, with a
// worker per core they slow each other ~5x, and one blocking a worker past vitest's 60 s RPC limit
// fails the run ("Timeout calling onTaskUpdate") even when every test passes. So half the cores,
// but never fewer than two.
const cores = availableParallelism();

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    maxWorkers: process.env.CI ? cores : Math.max(2, Math.floor(cores / 2)),
  },
});
