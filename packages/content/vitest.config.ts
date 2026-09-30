import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/content",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
