import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/narrator",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
