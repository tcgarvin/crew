/**
 * Environment configuration (W8). Read once at startup; every value the rest of the package
 * needs is derived here so nothing else touches `process.env` directly.
 */

function readInt(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export interface Env {
  /** Neon Postgres connection string. Required in production; optional when `CREW_DB=memory`. */
  readonly databaseUrl: string | undefined;
  /** Use the in-memory fake db instead of Neon. Intended for dev and tests only. */
  readonly useMemoryDb: boolean;
  /** Passed through to the narrator ctx only; this package never calls the Anthropic SDK. */
  readonly anthropicApiKey: string | undefined;
  /** Max accepted save size, in bytes, measured on the gzipped blob (post-gzip, pre-base64). */
  readonly maxSaveBytes: number;
  /** Narrator budget: max calls per game per rolling wall-clock hour. */
  readonly narratorMaxCallsPerHour: number;
  readonly nodeEnv: string;
}

/**
 * Builds the effective config from `process.env`. Throws with a clear message if `DATABASE_URL`
 * is missing outside dev/test with `CREW_DB=memory`.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? "development";
  const useMemoryDb = source.CREW_DB === "memory";
  const databaseUrl = source.DATABASE_URL;

  if (!useMemoryDb && !databaseUrl && nodeEnv === "production") {
    throw new Error(
      "DATABASE_URL is required in production (set CREW_DB=memory only for local dev/tests).",
    );
  }

  return {
    databaseUrl,
    useMemoryDb,
    anthropicApiKey: source.ANTHROPIC_API_KEY,
    maxSaveBytes: readInt(source, "CREW_SAVE_MAX_BYTES", 4 * 1024 * 1024),
    narratorMaxCallsPerHour: readInt(source, "CREW_NARRATOR_MAX_CALLS_PER_HOUR", 6),
    nodeEnv,
  };
}
