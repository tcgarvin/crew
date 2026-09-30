import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/sim",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
