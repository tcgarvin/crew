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

export type NarratorCallStatus = "ok" | "error" | "budgetExceeded";

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
  /** Narrator calls for a game within the last `sinceMs` milliseconds (wall clock), for the hourly budget. */
  countNarratorCallsSince(gameId: string, sinceMs: number): Promise<number>;
  /** Most recent narrator call for a game, if any, for the min-ticks-between-calls check. */
  getLastNarratorCall(gameId: string): Promise<NarratorCallRow | undefined>;
}
