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
| `OPENROUTER_API_KEY` | For the real narrator (W9) | Passed through as `NarratorCtx.openRouterApiKey`. Without it the narrator falls back with reason `notConfigured`: in `CREW_NARRATOR_FALLBACK=error` mode the route answers 503, otherwise the deterministic null narrator answers the hook. |
| `CREW_NARRATOR_FALLBACK` | No (default `error` when `NODE_ENV=production`, `null` otherwise) | D43: what the narrator route does when the model cannot answer. `error`: no key → 503 `narratorUnavailable` (`reason: "notConfigured"`, not retryable); any model failure (`apiError`, `timeout`, `refusal`, `truncated`, `schemaInvalid`) → 502 `narratorUnavailable` with the reason and `retryable: true`; the call is logged with status `error`, and the client retries with backoff then pauses the game on an error panel. `null`: the deterministic template narrator answers instead (tests, local dev without a key, explicit offline use). Players must never get the null narrator, so leave this unset in production (Vercel sets `NODE_ENV=production` for the function runtime) or set it to `error` explicitly. Any other value fails startup. |
| `CREW_NARRATOR_MODEL` | No (default `anthropic/claude-sonnet-4.6`, `DEFAULT_SERVER_NARRATOR_MODEL` in `src/env.ts`) | OpenRouter model slug for the narrator. The model that actually answered is recorded in `narrator_calls.model`. |
| `CREW_SAVE_MAX_BYTES` | No (default 4 MiB) | Max accepted save size, measured on the **gzipped** blob. Vercel functions cap request bodies at 4.5 MB, so leave headroom above this for base64 + JSON overhead if raising it. |
| `CREW_NARRATOR_MAX_CALLS_PER_HOUR` | No (default 30) | Per-game narrator call budget (rolling wall-clock hour); a there-and-back passage to a far port is about ten calls as measured by `crew pacing` (D51; the spec's estimate was eight, passengers-and-galaxy §2.2, §8.6). A second budget knob — minimum sim ticks between calls — is currently a constant in `src/routes/narrator.ts` (`MIN_TICKS_BETWEEN_NARRATOR_CALLS`), not yet an env var. |

`env.ts`'s `loadEnv()` throws immediately if `DATABASE_URL` is missing and `NODE_ENV=production`
and `CREW_DB` isn't `memory` — fail fast rather than silently falling back in prod.

## Reading the narrator log

`pnpm --filter @crew/server narrator-log` is a read-only terminal view of `narrator_calls`
(`src/tools/narratorLog.ts`; the CLI shell is `src/tools/narratorLogCli.ts`). It reads
`DATABASE_URL` from the environment, or from `packages/server/.env.local` (gitignored via `.env*`)
when the variable is unset and that file exists. Use a Neon **read-only role** or a **branch** of
production for it, not the production writer: the script only ever `SELECT`s, but the credential
in that file should not be able to do more. The script never prints the URL; error messages are
scrubbed of the connection string, its user, password and host before they reach the terminal.

```
pnpm --filter @crew/server narrator-log games
pnpm --filter @crew/server narrator-log calls [--game <id|prefix>] [--last N] [--hook <kind>] [--status ok|error|budgetExceeded]
pnpm --filter @crew/server narrator-log call <id|prefix> [--raw]
pnpm --filter @crew/server narrator-log notes [--game <id|prefix>]
pnpm --filter @crew/server narrator-log digest <callId|prefix>
```

`games` lists every game with its call count and the last call's prompt version. `calls` prints
one block per call, newest first (default: the last 10 for the most recently updated game): the
header line (time, hook, status, model, prompt version, latency, tokens), the card prose, every
surfaced decision and job offer, other commands, dropped intents, fallback reason and error.
`call` adds the model's rationale (when a prompt version recorded one) and the full notes update;
`--raw` also dumps the stored request (which includes the whole snapshot) and response JSON.
`notes` prints the game's current `narrative_notes`. `digest` rebuilds the digest the model was
shown by running `@crew/narrator`'s `buildDigest` on the stored snapshot, hook and recent events,
with the notes taken from the previous ok call's `notesUpdate` (the request row does not store
them); it uses today's digest code, so it can differ from what an older prompt version produced.
Ids may be given as any unambiguous prefix. Fields missing from older prompt versions print as `-`.

## Live narrator tests

`pnpm test` never makes a model call (every transport is a fake), so it cannot see the upstream
provider rejecting the real request: a prompt, schema or transport change can leave the unit
suite green and production answering every hook with `apiError` (as happened on 2026-10-01:
"OpenRouter 400: Provider returned error"). `pnpm test:live` (D44) is the check for that:

```
pnpm test:live
```

It runs `packages/narrator/src/live/narrator.live.test.ts` through the root
`vitest.live.config.ts`: one real OpenRouter call per hook kind (`approachingPort`, `jobBoard`,
`quietTooLong`, `notableEvent`, `policyDecision`) with the production `openRouterTransport`,
prompt and JSON schema, plus one repeated call that checks prompt caching reports cache-read
tokens. Each test fails on any fallback and prints the narrator's error, which includes the
provider's own text in brackets, so the reason is visible without reading the call log. Tests
run one at a time with a 60 s timeout each.

Run it by hand before deploying anything that touches the narrator prompt (`src/prompts/`), the
plan schema (`plan.ts`, `contract.ts`), the transport (`openrouter.ts`, `run.ts`) or the model
slug. It is not part of `pnpm test` (the narrator package's `vitest.config.ts` excludes
`src/live/`), and it does not run in CI.

The key comes from `OPENROUTER_API_KEY` in the environment, or from
`packages/narrator/.env.local` (gitignored by the root `.env*` rule) when the variable is unset
and that file exists:

```
# packages/narrator/.env.local
OPENROUTER_API_KEY=sk-or-...
```

Without a key the whole file is skipped (reported as 6 skipped tests), never failed, so a
checkout without credentials still runs it cleanly. `CREW_NARRATOR_MODEL` overrides the model;
the default is the narrator package's `DEFAULT_NARRATOR_MODEL`, which may differ from the
server's `DEFAULT_SERVER_NARRATOR_MODEL`, so set it to the production slug to test what
production sends. The key is never printed.

Cost: seven calls of a few thousand input tokens and a few hundred output tokens each, on the
order of tens of cents per run with Claude Opus 4.6 and less with Sonnet; the second half of the
repeated call reads its system prefix from cache.

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

## Shipping

The Vercel project is connected to `github.com/tcgarvin/crew` (private). A push to `main` builds
and deploys production; any other branch or PR gets a preview deployment. Both run the same
build command, so both run migrations against the database their environment points at:
production uses Neon's `main` branch; each preview gets its own Neon branch,
`preview/<git-branch>`, copied from `main` (the Neon integration's "Create Database Branch For
Deployment: Preview" setting — Production must stay unchecked). Neon does not delete a preview
branch when its git branch goes away; remove it with
`neonctl branches delete preview/<git-branch> --project-id restless-voice-83603994`. GitHub
Actions (`.github/workflows/ci.yml`) runs typecheck, lint, depcruise and tests on every push and
PR, independently of the Vercel build. `vercel deploy` from a laptop still works but is no longer
the normal path.

## Operations reference

Claude owns deployment and environment work for this project; the user provides interactive
logins, API keys, and anything only a human can approve (below). Set up on 2026-10-03.

### Where things live

| What | Identifier |
| --- | --- |
| GitHub repo | `github.com/tcgarvin/crew` (private), remote `origin` |
| Vercel team / project | `tims-projects-6bc94f1b` (`team_zOyNZQQhuDYkeBpNBe0myKWl`) / `crew` (`prj_HEmbFJNcNZ39YYpDQ122FL6ViFdv`) |
| Production URL | `https://crew-neon-omega.vercel.app` |
| Neon org / project | `org-aged-lab-13621729` ("Vercel: Tim's projects") / `neon-crew` (`restless-voice-83603994`), aws-us-east-1, Postgres 18 |
| Prod database | branch `main` (`br-winter-water-b7iyn7oz`), database `neondb`, owner `neondb_owner` |
| Read-only role | `claude_ro`; URL in `.env.local` as `PROD_RO_DATABASE_URL` |
| Neon integration settings | Vercel dashboard → Storage → `neon-crew` → connected project `crew` |

### Tooling on a new machine

- `vercel` CLI (`npm i -g vercel@latest`), then `vercel login`; `vercel link` if `.vercel/` is
  missing.
- `neonctl` (`npm i -g neonctl`), then `neonctl auth` (browser login). Pass
  `--org-id org-aged-lab-13621729` to `neonctl projects list`; the project is not in the
  personal org.
- `gh` logged in as `tcgarvin`.
- Docker, for `scripts/psql.sh` (no local `psql` needed).
- `.env.local` (gitignored) with `OPENROUTER_API_KEY` and `PROD_RO_DATABASE_URL`. To recreate the
  latter, the user runs `scripts/create-readonly-role.sh`.

### Common tasks

- Query prod: `scripts/psql.sh PROD_RO_DATABASE_URL -c '...'`. The role has `SELECT` only and
  sessions default to read-only; writes fail with `permission denied`.
- Check a deploy: `vercel ls crew`, then
  `vercel inspect <url> --wait` and `vercel inspect <url> --logs` (migration output is in the
  build log). Deployments are behind Vercel Authentication, so smoke-test with
  `vercel curl /api/health --deployment <url>`; the production alias answers plain `curl`.
- Vercel REST calls without handling tokens: `vercel api <path>` (e.g. `/v9/projects/crew`).
- Test against real data with writes: `neonctl branches create --project-id
  restless-voice-83603994 --name <name>` (copies `main`), get its URL with
  `neonctl connection-string <name> --project-id restless-voice-83603994`, run with that as
  `DATABASE_URL`, then delete the branch.
- Clean up preview databases: `neonctl branches list --project-id restless-voice-83603994` and
  delete `preview/*` branches whose git branch is gone.

### What needs the user

- Interactive logins (`vercel login`, `neonctl auth`, `gh auth login`).
- Changes to the production database or its roles: Claude Code's safety checks block Claude from
  running these, so Claude writes the script or command and the user runs it.
- Settings that live only in a dashboard: the Neon integration (preview branching, env prefix),
  GitHub app access for Vercel, Vercel account login connections.
- Edits to Claude's own permissions in `.claude/settings.json` / `settings.local.json`.
