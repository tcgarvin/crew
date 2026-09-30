/**
 * Writes the deployment as Vercel Build Output API v3 (`.vercel/output`), after the web build.
 *
 * Why not zero-config `api/index.ts`: Vercel's Node builder transpiles each file on its own and
 * leaves imports as written, but the workspace packages are TypeScript-source packages
 * (`"exports": "./src/index.ts"`, extensionless relative imports, JSON imports without import
 * attributes) that only a bundler can resolve — the function builds and then fails at runtime.
 * So the server is bundled here with esbuild into one ESM file and published as the `api`
 * function; every `/api/*` request is routed to it and Hono routes on the original path.
 *
 * Usage (from the repo root, after `pnpm --filter @crew/web build`): `node scripts/vercel-output.mjs`
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".vercel/output");
const funcDir = path.join(out, "functions/api.func");

rmSync(out, { recursive: true, force: true });
mkdirSync(funcDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "packages/server/src/vercel.ts")],
  outfile: path.join(funcDir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "warning",
  // Some CommonJS dependencies call `require`; give the ESM bundle one.
  banner: {
    js: "import { createRequire as __crewCreateRequire } from 'node:module'; const require = __crewCreateRequire(import.meta.url);",
  },
});

writeFileSync(
  path.join(funcDir, ".vc-config.json"),
  `${JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
    },
    null,
    2,
  )}\n`,
);

cpSync(path.join(root, "apps/web/dist"), path.join(out, "static"), { recursive: true });

writeFileSync(
  path.join(out, "config.json"),
  `${JSON.stringify(
    {
      version: 3,
      routes: [
        { handle: "filesystem" },
        { src: "^/api(?:/.*)?$", dest: "/api" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2,
  )}\n`,
);

console.log(`vercel-output: wrote ${path.relative(root, out)} (static + api function)`);
