/**
 * Environment configuration (W8). Read once at startup; every value the rest of the package
 * needs is derived here so nothing else touches `process.env` directly.
 */
import { REASONING_EFFORTS, type ReasoningEffort, STAGING_TIMEOUT_MS } from "@crew/narrator";

function readInt(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** An OpenRouter model slug from `name`; unset or empty = `fallback`. */
function readReasoningEffort(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: ReasoningEffort,
): ReasoningEffort {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const effort = REASONING_EFFORTS.find((e) => e === raw);
  if (effort === undefined) {
    throw new Error(
      `Invalid ${name}: expected one of ${REASONING_EFFORTS.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return effort;
}

function readModel(source: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = source[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * Integration 2: the model used when `CREW_NARRATOR_MODEL` is unset — cheaper than the
 * narrator package's own default for the first live runs; the owner can raise it via env.
 */
export const DEFAULT_SERVER_NARRATOR_MODEL = "anthropic/claude-sonnet-4.6";

/**
 * D43: what the narrator route does when the model cannot answer. `"error"` refuses the hook
 * (503 without a key, 502 on a model failure) so the client retries and, failing that, pauses
 * the game; `"null"` answers with the deterministic template narrator instead. Players must
 * never get the null narrator, so production defaults to `"error"`.
 */
export type NarratorFallbackMode = "error" | "null";

function readNarratorFallback(source: NodeJS.ProcessEnv, nodeEnv: string): NarratorFallbackMode {
  const raw = source.CREW_NARRATOR_FALLBACK;
  if (raw === undefined || raw === "") return nodeEnv === "production" ? "error" : "null";
  if (raw === "error" || raw === "null") return raw;
  throw new Error(
    `Invalid CREW_NARRATOR_FALLBACK: expected "error" or "null", got ${JSON.stringify(raw)}`,
  );
}

export interface Env {
  /** Neon Postgres connection string. Required in production; optional when `CREW_DB=memory`. */
  readonly databaseUrl: string | undefined;
  /** Use the in-memory fake db instead of Neon. Intended for dev and tests only. */
  readonly useMemoryDb: boolean;
  /** `OPENROUTER_API_KEY`, passed through to the narrator ctx only (W9: OpenRouter transport). */
  readonly openRouterApiKey: string | undefined;
  /** `CREW_NARRATOR_MODEL`: OpenRouter model slug; unset = `DEFAULT_SERVER_NARRATOR_MODEL`. */
  readonly narratorModel: string;
  /**
   * D67: `CREW_STAGING_MODEL`, the model for the staging call (`stageDock`); unset = the story
   * model, so the staging call can move to a cheaper model without touching the story's.
   */
  readonly stagingModel: string;
  /**
   * D96: `CREW_NARRATOR_REASONING_EFFORT`, one of `REASONING_EFFORTS`; unset = `"default"`, which
   * sends nothing. Set it per model: on a model that does not reason by default, any other value
   * switches reasoning on.
   */
  readonly narratorReasoningEffort: ReasoningEffort;
  /** D96: `CREW_STAGING_REASONING_EFFORT`; unset = the story call's, like `stagingModel`. */
  readonly stagingReasoningEffort: ReasoningEffort;
  /**
   * D70: `CREW_STAGING_TIMEOUT_MS`, how long one staging attempt may take before it gives up
   * (milliseconds); unset = the narrator's `STAGING_TIMEOUT_MS` (10 s). Story calls keep 25 s.
   */
  readonly stagingTimeoutMs: number;
  /**
   * `CREW_NARRATOR_FALLBACK` (D43): `"error"` or `"null"`; unset = `"error"` when
   * `NODE_ENV=production`, `"null"` otherwise (local dev without a key and the test suite).
   */
  readonly narratorFallback: NarratorFallbackMode;
  /** Max accepted save size, in bytes, measured on the gzipped blob (post-gzip, pre-base64). */
  readonly maxSaveBytes: number;
  /** Narrator budget: max calls per game per rolling wall-clock hour. */
  readonly narratorMaxCallsPerHour: number;
  readonly nodeEnv: string;
  /**
   * D97: `VERCEL=1`, set by Vercel in its functions: work after the response goes to
   * `waitUntil`; elsewhere it runs inline.
   */
  readonly onVercel: boolean;
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

  const narratorModel = readModel(source, "CREW_NARRATOR_MODEL", DEFAULT_SERVER_NARRATOR_MODEL);
  const narratorReasoningEffort = readReasoningEffort(
    source,
    "CREW_NARRATOR_REASONING_EFFORT",
    "default",
  );
  return {
    databaseUrl,
    useMemoryDb,
    openRouterApiKey: source.OPENROUTER_API_KEY,
    narratorModel,
    stagingModel: readModel(source, "CREW_STAGING_MODEL", narratorModel),
    narratorReasoningEffort,
    stagingReasoningEffort: readReasoningEffort(
      source,
      "CREW_STAGING_REASONING_EFFORT",
      narratorReasoningEffort,
    ),
    stagingTimeoutMs: readInt(source, "CREW_STAGING_TIMEOUT_MS", STAGING_TIMEOUT_MS),
    narratorFallback: readNarratorFallback(source, nodeEnv),
    maxSaveBytes: readInt(source, "CREW_SAVE_MAX_BYTES", 4 * 1024 * 1024),
    narratorMaxCallsPerHour: readInt(source, "CREW_NARRATOR_MAX_CALLS_PER_HOUR", 45),
    nodeEnv,
    onVercel: source.VERCEL === "1",
  };
}
