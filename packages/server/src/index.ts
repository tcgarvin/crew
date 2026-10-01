import { Hono } from "hono";
import { MintRateLimiter, clientIp, hashToken, mintToken, requireAuth } from "./auth";
import type { AuthAnonResponse } from "./contract";
import { createDb } from "./db/client";
import type { Db } from "./db/types";
import { type Env, loadEnv } from "./env";
import { type RunNarrator, defaultNarrator } from "./narrator";
import { registerGameRoutes } from "./routes/games";
import { registerNarratorRoutes } from "./routes/narrator";
import { registerSaveRoutes } from "./routes/saves";

export * from "./contract";
export type { Db } from "./db/types";
export { createDb } from "./db/client";
export { DEFAULT_SERVER_NARRATOR_MODEL, loadEnv } from "./env";
export type { Env } from "./env";
export { defaultNarrator, nullNarrator } from "./narrator";
export type { NarratorCtx, NarratorOutcome, RunNarrator } from "./narrator";

export interface AppEnv {
  Variables: { userId: string };
}

export interface AppDeps {
  readonly db: Db;
  readonly env: Env;
  /** Tests inject a fake here; defaults to `defaultNarrator` (W9). */
  readonly runNarrator?: RunNarrator;
}

/**
 * Builds the Hono app: auth, games/saves API, and narrator orchestration (W8). Takes its
 * dependencies (db, env, narrator) so tests can inject an in-memory `Db` and a fake narrator
 * without touching Neon or an LLM.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { db, env, runNarrator = defaultNarrator } = deps;
  const app = new Hono<AppEnv>();
  const mintLimiter = new MintRateLimiter();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/auth/anon", async (c) => {
    if (!mintLimiter.allow(clientIp(c))) {
      return c.json(
        {
          error: {
            code: "badRequest",
            message: "Too many tokens minted from this IP; try again later.",
          },
        },
        429,
      );
    }
    const token = mintToken();
    const user = await db.createUser(hashToken(token));
    const body: AuthAnonResponse = { userId: user.id, token };
    return c.json(body, 201);
  });

  const authed = new Hono<AppEnv>();
  authed.use("*", requireAuth(db));
  registerGameRoutes(authed, db);
  registerSaveRoutes(authed, db, env);
  registerNarratorRoutes(authed, db, env, runNarrator);
  app.route("/", authed);

  return app;
}

/**
 * The default app, built from `process.env`. Uses the in-memory db unless `DATABASE_URL` is set
 * (or falls back to it, and fails fast, if `NODE_ENV=production` without one — see `env.ts`).
 */
const defaultEnv = loadEnv();
export const app = createApp({ db: createDb(defaultEnv), env: defaultEnv });

export default app;
