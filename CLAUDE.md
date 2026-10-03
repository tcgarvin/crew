# Crew — notes for Claude

Read `README.md` for layout and `docs/PLAN.md` / `docs/DECISIONS.md` for design. This file holds
only what those don't.

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
- Design decisions get the next `D<n>` entry in `docs/DECISIONS.md`, and commit messages cite
  them, e.g. `... (D56)`.

## Deployment and environment

Claude owns deployment and environment setup; the user supplies logins and API keys only.

- Vercel project `crew` (team `tims-projects-6bc94f1b`), linked in `.vercel/` and Git-connected to
  `github.com/tcgarvin/crew`: push to `main` = production deploy, other branches = previews. Build steps
  are in `vercel.json` and explained in `docs/DEPLOYMENT.md`. Migrations run in the Vercel build,
  which is the only path that changes the prod schema.
- Neon Postgres, provisioned through the Vercel Marketplace. Its env vars are marked sensitive
  and arrive as placeholders from `vercel env pull`.
- Prod data: read-only via `scripts/psql.sh PROD_RO_DATABASE_URL ...` (role `claude_ro`, URL in
  gitignored `.env.local`). For anything that writes, make a Neon branch of prod with `neonctl`
  and point `DATABASE_URL` at the branch; delete the branch afterwards.
- `psql` runs in Docker (`postgres:17-alpine`) via `scripts/psql.sh`; there is no local install.
- Never put a prod connection string in a variable named `DATABASE_URL` locally — the dev server
  and `drizzle-kit` read that name.
