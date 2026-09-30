import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/server",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
