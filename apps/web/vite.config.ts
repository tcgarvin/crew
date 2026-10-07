import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * W7 needs the dev server to work standalone (no `packages/server` running) so the worker/UI can
 * be built and screenshotted without the API. This answers `/api/health` directly; every other
 * `/api/*` path still proxies to the real server per the config below.
 */
function stubHealthEndpoint(): Plugin {
  return {
    name: "stub-api-health",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/api/health") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), stubHealthEndpoint()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  test: {
    name: "@crew/web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["../../vitest.setup.ts"],
  },
});
