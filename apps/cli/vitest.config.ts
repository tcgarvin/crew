import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/cli",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
