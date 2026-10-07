/**
 * The `Db` interface every route depends on, plus the plain row shapes it returns. Two
 * implementations: `DrizzleDb` (`./queries.ts`, real Neon Postgres) and `MemoryDb`
 * (`./memory.ts`, in-memory fake for dev/tests). Keeping this a plain interface — not a class —
 * means routes can be tested against either without touching a network.
 */

export interface UserRow {
  readonly id: string;
  readonly anonTokenHash: string;
  readonly createdAt: Date;
}

export interface GameRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly headSaveId: string | null;
  readonly leaseEpoch: number;
  readonly narrativeNotes: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveRow {
  readonly id: string;
  readonly gameId: string;
  readonly blob: Buffer;
  readonly schemaVersion: number;
  readonly simVersion: string;
  readonly contentHash: string;
  readonly savedAtTick: number;
  readonly isMilestone: boolean;
  readonly createdAt: Date;
  /** Monotonic insertion sequence; breaks `createdAt` ties deterministically (see schema.ts). */
  readonly seq: number;
}

/** D97: `pending` is a notes turn still running after its plan was answered. */
export type NarratorCallStatus = "ok" | "error" | "budgetExceeded" | "pending";

/**
 * D67: the kinds of narrator call. A staging call is exactly a `stageDock` hook, so the kind is
 * read from `hook_kind` rather than stored twice: no column, no migration. D97: a notes turn is
 * logged as its own row with hook kind `notes`; it is not a story call, so it neither uses the
 * story budget nor spaces the next story call.
 */
export type NarratorCallKind = "story" | "staging" | "notes";
export const STAGING_HOOK_KIND = "stageDock";
export const NOTES_HOOK_KIND = "notes";

export function narratorCallKind(hookKind: string): NarratorCallKind {
  if (hookKind === STAGING_HOOK_KIND) return "staging";
  return hookKind === NOTES_HOOK_KIND ? "notes" : "story";
}

export interface NarratorCallRow {
  readonly id: string;
  readonly gameId: string;
  readonly hookKind: string;
  readonly basisSaveId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly status: NarratorCallStatus;
  readonly request: unknown;
  readonly response: unknown;
  readonly error: string | null;
  readonly createdAt: Date;
  /** Monotonic insertion sequence; breaks `createdAt` ties deterministically (see schema.ts). */
  readonly seq: number;
}

export interface PutSaveInput {
  readonly gameId: string;
  readonly blob: Buffer;
  readonly schemaVersion: number;
  readonly simVersion: string;
  readonly contentHash: string;
  readonly savedAtTick: number;
  readonly isMilestone: boolean;
}

export interface LogNarratorCallInput {
  readonly gameId: string;
  readonly hookKind: string;
  readonly basisSaveId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly status: NarratorCallStatus;
  readonly request: unknown;
  readonly response: unknown;
  readonly error: string | null;
}

/** D97: what a finished notes turn writes over its `pending` row. */
export interface FinishNarratorCallInput {
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  readonly status: "ok" | "error";
  readonly response: unknown;
  readonly error: string | null;
}

/** Narrator-call filter for the read-only log tooling (`src/tools/narratorLog.ts`). */
export interface NarratorCallFilter {
  readonly gameId?: string;
  readonly hookKind?: string;
  readonly status?: NarratorCallStatus;
  /** D67: story calls only, or staging calls only. */
  readonly kind?: NarratorCallKind;
  /** Upper bound on rows returned; newest first. */
  readonly limit: number;
}

/** A game plus a summary of its narrator calls, for `narrator-log games`. */
export interface GameNarratorSummary {
  readonly game: GameRow;
  readonly callCount: number;
  readonly lastCallAt: Date | null;
  readonly lastPromptVersion: string | null;
}

export interface Db {
  createUser(anonTokenHash: string): Promise<UserRow>;
  getUserByTokenHash(anonTokenHash: string): Promise<UserRow | undefined>;

  createGame(userId: string, name: string): Promise<GameRow>;
  listGames(userId: string): Promise<readonly GameRow[]>;
  getGame(gameId: string): Promise<GameRow | undefined>;
  /** Bumps `lease_epoch` by 1 and returns the updated row. */
  bumpLease(gameId: string): Promise<GameRow>;

  /**
   * Inserts a save, sets it as the game's head, bumps `updated_at`, and prunes older non-
   * milestone saves for the game beyond the last 5 (by `created_at`). Milestone saves are never
   * pruned.
   */
  putSave(input: PutSaveInput): Promise<SaveRow>;
  getSave(saveId: string): Promise<SaveRow | undefined>;
  getHeadSave(gameId: string): Promise<SaveRow | undefined>;

  updateNotes(gameId: string, narrativeNotes: unknown): Promise<void>;

  logNarratorCall(input: LogNarratorCallInput): Promise<NarratorCallRow>;
  /** D97: completes a `pending` notes-turn row; throws if there is no such row. */
  finishNarratorCall(id: string, input: FinishNarratorCallInput): Promise<void>;
  /**
   * Narrator calls of one kind for a game within the last `sinceMs` milliseconds (wall clock),
   * for the hourly budget; rejections are not counted. D67: each kind has its own budget.
   */
  countNarratorCallsSince(gameId: string, sinceMs: number, kind: NarratorCallKind): Promise<number>;
  /** Most recent narrator call for a game, if any, for the min-ticks-between-calls check. */
  getLastNarratorCall(gameId: string): Promise<NarratorCallRow | undefined>;

  // Read-only queries for the narrator log CLI (`src/tools/narratorLog.ts`). The narrator route
  // also uses `listNarratorCalls` for the last answered call (spacing check).

  /** Every game (all users), most recently updated first, with narrator-call counts. */
  listGamesWithNarratorStats(): Promise<readonly GameNarratorSummary[]>;
  /** Narrator calls matching `filter`, newest first (`created_at desc, seq desc`). */
  listNarratorCalls(filter: NarratorCallFilter): Promise<readonly NarratorCallRow[]>;
  /** Narrator calls whose id starts with `prefix` (hex and dashes only); a full id matches one. */
  findNarratorCallsByIdPrefix(prefix: string): Promise<readonly NarratorCallRow[]>;
  /** Games whose id starts with `prefix` (hex and dashes only); a full id matches one. */
  findGamesByIdPrefix(prefix: string): Promise<readonly GameRow[]>;
}

/**
 * Id prefixes reach Postgres as a `LIKE` pattern, so only uuid characters are allowed; anything
 * else (including `%` and `_`) is rejected here rather than silently matching too much.
 */
export function assertIdPrefix(prefix: string): void {
  if (prefix === "" || !/^[0-9a-fA-F-]+$/.test(prefix)) {
    throw new Error(`Invalid id prefix: ${JSON.stringify(prefix)} (expected uuid characters)`);
  }
}
