import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@crew/narrator",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Live tests make real OpenRouter calls; `pnpm test:live` runs them (vitest.live.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "src/live/**"],
  },
});
