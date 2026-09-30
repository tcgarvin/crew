import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { createDb } from "./db/client";
import { loadEnv } from "./env";
import { createApp } from "./index";

// Dev server defaults to the in-memory db so `pnpm --filter @crew/server dev` needs no Neon
// connection; set DATABASE_URL (and unset CREW_DB, or set it to something other than "memory")
// to run against a real Postgres instead.
const env = loadEnv({ ...process.env, CREW_DB: process.env.CREW_DB ?? "memory" });
const app = new Hono();
// Dev only: log every request (method, path, status, time) so a local run shows its traffic.
app.use(logger());
app.route("/", createApp({ db: createDb(env), env }));

const port = 3001;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `@crew/server dev listening on http://localhost:${info.port} (db: ${env.useMemoryDb ? "memory" : "neon"})`,
  );
});
