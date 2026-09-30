import { Hono } from "hono";

/**
 * The Hono app: auth, games/saves API, and narrator orchestration.
 * Only the `GET /api/health` route is wired up for the scaffold; everything
 * else (Drizzle + SQL migrations, anon auth, saves, narrator endpoint) lands
 * with W8/W9.
 */
export const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
