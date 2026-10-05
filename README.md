# Crew

A small freighter deck with an autonomous crew, ship systems that degrade and get repaired, a
freight and passenger loop across six ports (a core triangle and three far spurs), and an LLM narrator hook. Off watch,
the crew play cards, spar, read and argue in the lounge, and the digest names their rivalries. See `docs/PLAN.md` for the full
design and `docs/DECISIONS.md` for rule rationale.

## Stack

TypeScript end-to-end, pnpm workspaces, Vite + React 19 for the web client, Hono for the API
(deployed as Vercel Node functions), Neon Postgres, Vitest, Biome, dependency-cruiser.

## Layout

```
packages/sim/        kernel — zero dependencies, no DOM/Node globals
packages/content/     Zod schemas + authored JSON content
packages/narrator/    LLM digest/prompt/command-translation layer
packages/server/      Hono app (auth, saves, narrator orchestration)
apps/web/             Vite + React client; api/ holds the Vercel function entry
apps/cli/             headless runner / content validation scripts
```

Dependency direction is enforced by dependency-cruiser (`.dependency-cruiser.cjs`):
`sim` depends on nothing; `content` may only reference `sim` via `import type`; `apps/web/src`
may never import `@crew/narrator` or `@crew/server`; `packages/sim/src/planner` may only see
`view/**` and `core/types*`.

## Running

```
pnpm install
pnpm typecheck   # tsc -b across the whole workspace
pnpm lint        # biome check .
pnpm depcruise   # dependency boundary rules
pnpm test        # vitest run, one project per package/app
pnpm build       # tsc -b (compiles all packages/apps)

pnpm --filter @crew/server dev   # Hono API on :3001
pnpm --filter @crew/web dev      # Vite dev server, proxies /api to :3001
```

Pushing to `main` deploys production; other branches get previews with their own database
branch. See `docs/DEPLOYMENT.md` ("Shipping" and "Operations reference").

## Toolchain notes

- **Module/resolution**: `tsconfig.base.json` uses `"module": "ESNext"` with
  `"moduleResolution": "Bundler"`. This is the one setting that works cleanly for both halves of
  the project: Vite (and its own esbuild/rollup resolution) expects bundler-style resolution, and
  `tsc -b` has supported `moduleResolution: "bundler"` since TS 5.0. The alternative,
  `NodeNext`, requires explicit `.js` extensions on every relative import of a `.ts` file, which
  doesn't match how internal packages are consumed here (each workspace package's `exports`
  field points straight at `./src/index.ts` — there is no compiled `dist` to resolve against
  during development).
- **`build` vs `typecheck`**: both run `tsc -b`. `tsc -b --noEmit` isn't supported with project
  references (composite projects must emit `.d.ts` files so downstream references can see each
  other's types), so rather than fight that, `typecheck` is just `tsc -b` again. `tsc -b` is
  incremental (`.tsbuildinfo` per project) and a clean re-run after `build` already ran is fast,
  so running it twice in CI (`build`-adjacent `typecheck`, then again for anything not built) is
  cheap. This is the simplest arrangement that actually enforces project-reference boundaries.
- **`packages/sim`**: `tsconfig.json` sets `"lib": ["ES2022"]` and `"types": []`, so any
  accidental use of DOM or Node globals fails to type-check — the kernel must stay
  host-agnostic.
- **`apps/web`**: uses a solution-style `tsconfig.json` (no `files`, just `references`) pointing
  at `tsconfig.app.json` (browser code under `src/`, DOM lib) and `tsconfig.node.json`
  (`vite.config.ts`, Node lib) — the standard Vite + TS project split.
- **Vercel**: the build command (root `vercel.json`) runs migrations, builds `@crew/web`, then
  `scripts/vercel-output.mjs`, which writes Build Output API v3: the web `dist/` as static files
  and `packages/server/src/vercel.ts` bundled by esbuild into one `api` function that serves every
  `/api/*` route. See `docs/DEPLOYMENT.md` for why it is bundled rather than a zero-config `api/`.
