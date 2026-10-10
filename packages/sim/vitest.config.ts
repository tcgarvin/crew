import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/sim",
    environment: "node",
    setupFiles: ["../../vitest.setup.ts"],
    // Slice-5 integration: the headless deck runs (galley, recreation, damage) take 1-2 s alone
    // and passed Vitest's 5 s default under the full parallel suite.
    testTimeout: 15_000,
    include: ["src/**/*.test.ts"],
  },
});
