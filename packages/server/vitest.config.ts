import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/server",
    environment: "node",
    setupFiles: ["../../vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
