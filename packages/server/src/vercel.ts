/**
 * Vercel Node.js function entry. `scripts/vercel-output.mjs` bundles this file (with every
 * workspace package and dependency) into `.vercel/output/functions/api.func` — see that script
 * for why it is bundled rather than left to zero-config `api/` detection. The default `app` is
 * built from `process.env` (`DATABASE_URL`, `OPENROUTER_API_KEY`, `CREW_NARRATOR_MODEL`, …).
 */
import { handle } from "@hono/node-server/vercel";
import { app } from "./index";

export default handle(app);
