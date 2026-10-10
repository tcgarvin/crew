# Crew — notes for Claude

Read `README.md` for layout, `docs/spec/` for how the game works now, and `docs/DECISIONS.md` for
the choices that shape it. This file holds only what those don't.

## Checks

Run before calling work done (CI runs the same four):

```
pnpm typecheck && pnpm lint && pnpm depcruise && pnpm test
```

`pnpm test:live` hits OpenRouter for real (needs `OPENROUTER_API_KEY` in `.env.local`); run it only
when narrator prompts or plan parsing change.

## Conventions

- TypeScript, not Python: the global Python standards apply in spirit — no silent failures, no
  catch-all handlers, no `null`/`undefined` doubling as several states, validate at boundaries
  (Zod in `packages/content`, request parsing in `packages/server`).
- Dependency direction is enforced by `pnpm depcruise`; fix the design, never the rule.
- Behaviour changes update the spec in the same commit: the section in `docs/spec/` that
  describes the mechanic, written to `docs/spec/README.md`. Code comments cite a section as
  `§<anchor>` (`§mess-call`); `pnpm lint` fails on one that names no heading.
- Only a real decision (a choice between alternatives that shapes much of the design, often an
  owner ruling) gets the next `D<n>` entry in `docs/DECISIONS.md`: a few lines of choice,
  alternatives and reason, never how a mechanic works. Most work needs no entry.

## Deployment and environment

Claude owns deployment and environment setup; the user supplies logins and API keys only.
IDs, new-machine setup, common commands, and what needs the user are in the "Operations
reference" section of `docs/DEPLOYMENT.md` — read it before any deploy or database work.

Delegate routine ops to the `ops` subagent (`.claude/agents/ops.md`, Haiku) rather than running
them in the main conversation: pushing committed work and verifying CI, the Vercel deploy, and the
health check; status checks; pruning preview databases. Call it yourself once work is committed
and checks pass — don't ask the user to. Tell it the branch, and say explicitly when a push to
`main` (production) is intended. Relay its report, including any failure.

- Vercel project `crew` (team `tims-projects-6bc94f1b`), linked in `.vercel/` and Git-connected to
  `github.com/tcgarvin/crew`: push to `main` = production deploy, other branches = previews,
  each on its own Neon branch `preview/<git-branch>` (`scripts/prune-preview-dbs.sh` finds and
  deletes the stale ones). Build steps
  are in `vercel.json` and explained in `docs/DEPLOYMENT.md`. Migrations run in the Vercel build,
  which is the only path that changes the prod schema.
- Neon Postgres, provisioned through the Vercel Marketplace. Its env vars are marked sensitive
  and arrive as placeholders from `vercel env pull`.
- Prod data: read-only via `scripts/psql.sh PROD_RO_DATABASE_URL ...` (role `claude_ro`, URL in
  gitignored `.env.local`). For anything that writes, make a Neon branch of prod with `neonctl`
  and point `DATABASE_URL` at the branch; delete the branch afterwards.
- `psql` runs in Docker (`postgres:17-alpine`) via `scripts/psql.sh`; there is no local install.
- `.claude/settings.json` pre-approves checks and read-only ops commands; anything that deploys
  outside a git push or writes to prod should be surfaced to the user.
- Never put a prod connection string in a variable named `DATABASE_URL` locally — the dev server
  and `drizzle-kit` read that name.
