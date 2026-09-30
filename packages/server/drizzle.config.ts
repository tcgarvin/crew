import { defineConfig } from "drizzle-kit";

/**
 * `pnpm --filter @crew/server exec drizzle-kit generate` regenerates `drizzle/*.sql` from
 * `src/db/schema.ts`; `pnpm --filter @crew/server exec drizzle-kit migrate` applies them to
 * `DATABASE_URL`. See `docs/DEPLOYMENT.md`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder/placeholder",
  },
});
