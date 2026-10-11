import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    // The real-content sims are CPU- and memory-heavy and run synchronously; with a worker per
    // core they slow each other ~5x, and one blocking a worker past vitest's 60 s RPC limit fails
    // the run ("Timeout calling onTaskUpdate") even when every test passes.
    maxWorkers: "50%",
  },
});
