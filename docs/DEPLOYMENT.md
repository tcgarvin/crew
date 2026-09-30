# Deployment (W8)

`packages/server` is stateless (PLAN §3): every request loads whatever it needs from the `Db`
and writes back before responding. The API runs as one Vercel Node function
(`src/vercel.ts`: `@hono/node-server/vercel`'s `handle(app)`, bundled — see "The Vercel function"
below) and locally with `@hono/node-server` (`src/dev.ts`, which also logs every request).

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

On Vercel, migrations run automatically as the first step of the build command (see
`vercel.json`): Neon marks `DATABASE_URL` as a sensitive variable, so it cannot be pulled locally
with `vercel env pull` (it arrives as `[SENSITIVE]`), but it is available to the build and to the
function at runtime. To migrate a local or throwaway database, set `DATABASE_URL` yourself.

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
| `OPENROUTER_API_KEY` | For the real narrator (W9) | Passed through as `NarratorCtx.openRouterApiKey`. Without it the server answers every hook with the deterministic null narrator. W9 decision: the narrator talks to OpenRouter (owner); the transport itself is still pending, so a set key currently yields `fallback: "notConfigured"` in `narrator_calls.response`. |
| `CREW_NARRATOR_MODEL` | No (default `anthropic/claude-sonnet-4.6`, `DEFAULT_SERVER_NARRATOR_MODEL` in `src/env.ts`) | OpenRouter model slug for the narrator. The model that actually answered is recorded in `narrator_calls.model`. |
| `CREW_SAVE_MAX_BYTES` | No (default 4 MiB) | Max accepted save size, measured on the **gzipped** blob. Vercel functions cap request bodies at 4.5 MB, so leave headroom above this for base64 + JSON overhead if raising it. |
| `CREW_NARRATOR_MAX_CALLS_PER_HOUR` | No (default 6) | Per-game narrator call budget (rolling wall-clock hour). A second budget knob — minimum sim ticks between calls — is currently a constant in `src/routes/narrator.ts` (`MIN_TICKS_BETWEEN_NARRATOR_CALLS`), not yet an env var. |

`env.ts`'s `loadEnv()` throws immediately if `DATABASE_URL` is missing and `NODE_ENV=production`
and `CREW_DB` isn't `memory` — fail fast rather than silently falling back in prod.

## The Vercel function

Integration 2. The build command in `vercel.json` ends with `node scripts/vercel-output.mjs`,
which writes `.vercel/output` in Build Output API v3 form: `apps/web/dist` as `static/`, and
`functions/api.func/index.mjs`, an esbuild bundle of `src/vercel.ts` (the default `app`, built
from `process.env` by `loadEnv()`, wrapped by `@hono/node-server/vercel`'s `handle`). The route
table sends `^/api(/.*)?$` to that function, which routes on the original path.

Why not a zero-config `api/index.ts`: Vercel's Node builder transpiles files one by one and keeps
imports as written, but the workspace packages export TypeScript source (`"exports":
"./src/index.ts"`), use extensionless relative imports and import JSON without import
attributes. The function builds, then fails at runtime. Bundling sidesteps all three.

Check locally without deploying: `vercel build` (the repo is linked) — it runs the build command
and keeps the generated output; `.vercel/output/functions/api.func/index.mjs` must exist. The
build command's first step migrates `DATABASE_URL`, so for a local check run
`pnpm --filter @crew/web build && node scripts/vercel-output.mjs` instead, or strip the migrate
step from a scratch copy of `vercel.json`. `CREW_DB=memory node -e` importing the bundle and
serving its default export with `node:http` is a quick smoke test.

Nothing about auth, saves, or narrator routing needs Vercel-specific code; the only Vercel-aware
piece is `src/waitUntil.ts`, which probes for `@vercel/functions`'s `waitUntil` at runtime and
falls back to awaiting inline when it isn't present (dev, tests) or there's no request context to
extend it (also dev, tests, or `@hono/node-server`).
