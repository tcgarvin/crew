# Deployment (W8)

`packages/server` is stateless (PLAN §3): every request loads whatever it needs from the `Db`
and writes back before responding. The API is designed to run as a Vercel Node function
(`apps/web/api/index.ts` imports `app` from `@crew/server` and re-exports its `fetch` handler —
Hono apps are Fetch-API-shaped, so no adapter is needed) and to run locally with
`@hono/node-server` (`src/dev.ts`).

## Running locally

```
pnpm --filter @crew/server dev     # in-memory db, http://localhost:3001
```

The dev server defaults to the in-memory `Db` (`CREW_DB=memory`) so it needs no Neon connection.
To run against a real Postgres instead, set `DATABASE_URL` and leave `CREW_DB` unset (or set it
to anything other than `memory`):

```
DATABASE_URL=postgres://... pnpm --filter @crew/server dev
```

Tests (`pnpm --filter @crew/server test`) always use the in-memory `Db` — see `src/db/memory.ts`
and `src/test-helpers.ts` — so they run fully offline and never touch Neon.

## Migrations

Schema lives in `src/db/schema.ts` (Drizzle); SQL migrations are generated and committed under
`drizzle/`. Regenerate after changing the schema, then apply:

```
pnpm --filter @crew/server exec drizzle-kit generate   # writes drizzle/*.sql from schema.ts
pnpm --filter @crew/server exec drizzle-kit migrate     # applies pending migrations, needs DATABASE_URL
```

`drizzle.config.ts` reads `DATABASE_URL` from the environment (a placeholder is used only so
`generate` can run without one; `migrate` needs the real value).

A throwaway local Postgres for manual testing against the real driver:

```
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @crew/server exec drizzle-kit migrate
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | In production (or whenever `CREW_DB` isn't `memory`) | Neon Postgres connection string, used by `@neondatabase/serverless` via `drizzle-orm/neon-http`. |
| `CREW_DB` | No | Set to `memory` to force the in-memory `Db` fake (dev/tests only). |
| `ANTHROPIC_API_KEY` | For the real narrator (W9) | Passed through to `runNarrator`'s `NarratorCtx.anthropicApiKey`; `@crew/server` never reads it beyond that — it has no LLM SDK dependency of its own. |
| `CREW_SAVE_MAX_BYTES` | No (default 4 MiB) | Max accepted save size, measured on the **gzipped** blob. Vercel functions cap request bodies at 4.5 MB, so leave headroom above this for base64 + JSON overhead if raising it. |
| `CREW_NARRATOR_MAX_CALLS_PER_HOUR` | No (default 6) | Per-game narrator call budget (rolling wall-clock hour). A second budget knob — minimum sim ticks between calls — is currently a constant in `src/routes/narrator.ts` (`MIN_TICKS_BETWEEN_NARRATOR_CALLS`), not yet an env var. |

`env.ts`'s `loadEnv()` throws immediately if `DATABASE_URL` is missing and `NODE_ENV=production`
and `CREW_DB` isn't `memory` — fail fast rather than silently falling back in prod.

## What the Vercel function entry expects

`apps/web/api/index.ts` (owned by W7) should:

1. Build (or import) an `Env` via `loadEnv()` from `@crew/server`.
2. Build a `Db` via `createDb(env)` from `@crew/server`.
3. Call `createApp({ db, env, runNarrator })` — `runNarrator` defaults to `nullNarrator` until W9
   supplies the real one; W9's function should be constructed once at module scope (it may hold
   an Anthropic client) and passed in, not rebuilt per request.
4. Export the resulting Hono app's `fetch` as the function's default export (Hono apps implement
   the standard Fetch API `fetch(Request): Promise<Response>`, which Vercel's Node runtime
   accepts directly).

Nothing about auth, saves, or narrator routing needs Vercel-specific code; the only Vercel-aware
piece is `src/waitUntil.ts`, which probes for `@vercel/functions`'s `waitUntil` at runtime and
falls back to awaiting inline when it isn't present (dev, tests) or there's no request context to
extend it (also dev, tests, or `@hono/node-server`).
