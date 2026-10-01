/**
 * `pnpm --filter @crew/server narrator-log <command> ...`: a read-only terminal view of
 * `narrator_calls` (see `./narratorLog.ts` for the commands). Reads `DATABASE_URL` from the
 * environment, or from `packages/server/.env.local` when that file exists, and never prints it:
 * error messages are scrubbed of the URL and its parts before they reach stderr.
 */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createNeonDatabase } from "../db/client";
import { DrizzleDb } from "../db/queries";
import { NarratorLogError, USAGE, redactDatabaseUrl, runNarratorLog } from "./narratorLog";

const ENV_FILE = fileURLToPath(new URL("../../.env.local", import.meta.url));

function readDatabaseUrl(): string {
  if (process.env.DATABASE_URL === undefined && existsSync(ENV_FILE)) loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new NarratorLogError(
      "DATABASE_URL is not set. Put it in packages/server/.env.local (gitignored) or the environment.",
    );
  }
  return url;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let databaseUrl = "";
  try {
    databaseUrl = readDatabaseUrl();
    const db = new DrizzleDb(createNeonDatabase(databaseUrl));
    process.stdout.write(`${await runNarratorLog(db, argv)}\n`);
    return 0;
  } catch (err) {
    // Message only, never a stack: driver errors can quote the connection details.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${redactDatabaseUrl(message, databaseUrl)}\n`);
    return err instanceof NarratorLogError ? 2 : 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
