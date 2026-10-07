/**
 * Real `Db` implementation over Neon (`drizzle-orm/neon-http`). Query layer is kept thin: each
 * method is a small, direct Drizzle query, with pruning and lease-bump logic that mirrors
 * `./memory.ts` exactly (tests run against the memory fake; this file is exercised only by hand
 * against a real Neon database — see `docs/DEPLOYMENT.md`).
 */
import { type SQL, and, desc, eq, gte, ne, notInArray, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { games, narratorCalls, saves, users } from "./schema";
import {
  type Db,
  type FinishNarratorCallInput,
  type GameNarratorSummary,
  type GameRow,
  type LogNarratorCallInput,
  NOTES_HOOK_KIND,
  type NarratorCallFilter,
  type NarratorCallKind,
  type NarratorCallRow,
  type PutSaveInput,
  STAGING_HOOK_KIND,
  type SaveRow,
  type UserRow,
  assertIdPrefix,
} from "./types";

/** D67: a staging call is a `stageDock` hook, D97 a notes turn `notes`; the rest are story. */
function kindCondition(kind: NarratorCallKind): SQL {
  if (kind === "staging") return eq(narratorCalls.hookKind, STAGING_HOOK_KIND);
  if (kind === "notes") return eq(narratorCalls.hookKind, NOTES_HOOK_KIND);
  return notInArray(narratorCalls.hookKind, [STAGING_HOOK_KIND, NOTES_HOOK_KIND]);
}

const ROLLING_SAVES_KEPT = 5;

type Schema = {
  users: typeof users;
  games: typeof games;
  saves: typeof saves;
  narratorCalls: typeof narratorCalls;
};
export type DrizzleDatabase = NeonHttpDatabase<Schema>;

function toGameRow(row: typeof games.$inferSelect): GameRow {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    headSaveId: row.headSaveId,
    leaseEpoch: row.leaseEpoch,
    narrativeNotes: row.narrativeNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSaveRow(row: typeof saves.$inferSelect): SaveRow {
  return {
    id: row.id,
    gameId: row.gameId,
    blob: row.blob,
    schemaVersion: row.schemaVersion,
    simVersion: row.simVersion,
    contentHash: row.contentHash,
    savedAtTick: row.savedAtTick,
    isMilestone: row.isMilestone,
    createdAt: row.createdAt,
    seq: row.seq,
  };
}

function toNarratorCallRow(row: typeof narratorCalls.$inferSelect): NarratorCallRow {
  return {
    id: row.id,
    gameId: row.gameId,
    hookKind: row.hookKind,
    basisSaveId: row.basisSaveId,
    model: row.model,
    promptVersion: row.promptVersion,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    status: row.status as NarratorCallRow["status"],
    request: row.request,
    response: row.response,
    error: row.error,
    createdAt: row.createdAt,
    seq: row.seq,
  };
}

export class DrizzleDb implements Db {
  constructor(private readonly db: DrizzleDatabase) {}

  async createUser(anonTokenHash: string): Promise<UserRow> {
    const [row] = await this.db.insert(users).values({ anonTokenHash }).returning();
    if (!row) throw new Error("createUser: insert returned no row");
    return row;
  }

  async getUserByTokenHash(anonTokenHash: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.anonTokenHash, anonTokenHash))
      .limit(1);
    return row;
  }

  async createGame(userId: string, name: string): Promise<GameRow> {
    const [row] = await this.db.insert(games).values({ userId, name }).returning();
    if (!row) throw new Error("createGame: insert returned no row");
    return toGameRow(row);
  }

  async listGames(userId: string): Promise<readonly GameRow[]> {
    const rows = await this.db.select().from(games).where(eq(games.userId, userId));
    return rows.map(toGameRow);
  }

  async getGame(gameId: string): Promise<GameRow | undefined> {
    const [row] = await this.db.select().from(games).where(eq(games.id, gameId)).limit(1);
    return row ? toGameRow(row) : undefined;
  }

  async bumpLease(gameId: string): Promise<GameRow> {
    const [row] = await this.db
      .update(games)
      .set({ leaseEpoch: sql`${games.leaseEpoch} + 1`, updatedAt: new Date() })
      .where(eq(games.id, gameId))
      .returning();
    if (!row) throw new Error(`bumpLease: no such game ${gameId}`);
    return toGameRow(row);
  }

  async putSave(input: PutSaveInput): Promise<SaveRow> {
    const [row] = await this.db
      .insert(saves)
      .values({
        gameId: input.gameId,
        blob: input.blob,
        schemaVersion: input.schemaVersion,
        simVersion: input.simVersion,
        contentHash: input.contentHash,
        savedAtTick: input.savedAtTick,
        isMilestone: input.isMilestone,
      })
      .returning();
    if (!row) throw new Error("putSave: insert returned no row");
    const saved = toSaveRow(row);

    await this.db
      .update(games)
      .set({ headSaveId: saved.id, updatedAt: new Date() })
      .where(eq(games.id, input.gameId));

    await this.pruneSaves(input.gameId);
    return saved;
  }

  async getSave(saveId: string): Promise<SaveRow | undefined> {
    const [row] = await this.db.select().from(saves).where(eq(saves.id, saveId)).limit(1);
    return row ? toSaveRow(row) : undefined;
  }

  async getHeadSave(gameId: string): Promise<SaveRow | undefined> {
    const game = await this.getGame(gameId);
    if (!game?.headSaveId) return undefined;
    return this.getSave(game.headSaveId);
  }

  async updateNotes(gameId: string, narrativeNotes: unknown): Promise<void> {
    await this.db
      .update(games)
      .set({ narrativeNotes, updatedAt: new Date() })
      .where(eq(games.id, gameId));
  }

  async logNarratorCall(input: LogNarratorCallInput): Promise<NarratorCallRow> {
    const [row] = await this.db.insert(narratorCalls).values(input).returning();
    if (!row) throw new Error("logNarratorCall: insert returned no row");
    return toNarratorCallRow(row);
  }

  async finishNarratorCall(id: string, input: FinishNarratorCallInput): Promise<void> {
    const rows = await this.db
      .update(narratorCalls)
      .set(input)
      .where(eq(narratorCalls.id, id))
      .returning({ id: narratorCalls.id });
    if (rows.length === 0) throw new Error(`finishNarratorCall: no narrator call ${id}`);
  }

  async countNarratorCallsSince(
    gameId: string,
    sinceMs: number,
    kind: NarratorCallKind,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - sinceMs);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(narratorCalls)
      .where(
        and(
          eq(narratorCalls.gameId, gameId),
          gte(narratorCalls.createdAt, cutoff),
          // Rejections never reach the model, so they must not keep the window full (D43).
          ne(narratorCalls.status, "budgetExceeded"),
          kindCondition(kind),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async getLastNarratorCall(gameId: string): Promise<NarratorCallRow | undefined> {
    const [row] = await this.db
      .select()
      .from(narratorCalls)
      .where(eq(narratorCalls.gameId, gameId))
      // `seq` breaks `created_at` ties deterministically (see schema.ts / memory.ts `byNewest`).
      .orderBy(desc(narratorCalls.createdAt), desc(narratorCalls.seq))
      .limit(1);
    return row ? toNarratorCallRow(row) : undefined;
  }

  async listGamesWithNarratorStats(): Promise<readonly GameNarratorSummary[]> {
    const stats = this.db
      .select({
        gameId: narratorCalls.gameId,
        callCount: sql<number>`count(*)::int`.as("call_count"),
        lastCallAt: sql<Date | string>`max(${narratorCalls.createdAt})`.as("last_call_at"),
        lastPromptVersion:
          sql<string>`(array_agg(${narratorCalls.promptVersion} order by ${narratorCalls.createdAt} desc, ${narratorCalls.seq} desc))[1]`.as(
            "last_prompt_version",
          ),
      })
      .from(narratorCalls)
      .groupBy(narratorCalls.gameId)
      .as("stats");
    const rows = await this.db
      .select({
        game: games,
        callCount: stats.callCount,
        lastCallAt: stats.lastCallAt,
        lastPromptVersion: stats.lastPromptVersion,
      })
      .from(games)
      .leftJoin(stats, eq(stats.gameId, games.id))
      .orderBy(desc(games.updatedAt));
    return rows.map((row) => ({
      game: toGameRow(row.game),
      callCount: row.callCount ?? 0,
      // Aggregates bypass drizzle's column mappers, so the driver may hand back a string.
      lastCallAt:
        row.lastCallAt === null || row.lastCallAt === undefined
          ? null
          : row.lastCallAt instanceof Date
            ? row.lastCallAt
            : new Date(row.lastCallAt),
      lastPromptVersion: row.lastPromptVersion ?? null,
    }));
  }

  async listNarratorCalls(filter: NarratorCallFilter): Promise<readonly NarratorCallRow[]> {
    const conditions: SQL[] = [];
    if (filter.gameId !== undefined) conditions.push(eq(narratorCalls.gameId, filter.gameId));
    if (filter.hookKind !== undefined) conditions.push(eq(narratorCalls.hookKind, filter.hookKind));
    if (filter.status !== undefined) conditions.push(eq(narratorCalls.status, filter.status));
    if (filter.kind !== undefined) conditions.push(kindCondition(filter.kind));
    const rows = await this.db
      .select()
      .from(narratorCalls)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(narratorCalls.createdAt), desc(narratorCalls.seq))
      .limit(filter.limit);
    return rows.map(toNarratorCallRow);
  }

  async findNarratorCallsByIdPrefix(prefix: string): Promise<readonly NarratorCallRow[]> {
    assertIdPrefix(prefix);
    const rows = await this.db
      .select()
      .from(narratorCalls)
      .where(sql`${narratorCalls.id}::text like ${`${prefix.toLowerCase()}%`}`)
      .orderBy(desc(narratorCalls.createdAt), desc(narratorCalls.seq));
    return rows.map(toNarratorCallRow);
  }

  async findGamesByIdPrefix(prefix: string): Promise<readonly GameRow[]> {
    assertIdPrefix(prefix);
    const rows = await this.db
      .select()
      .from(games)
      .where(sql`${games.id}::text like ${`${prefix.toLowerCase()}%`}`);
    return rows.map(toGameRow);
  }

  private async pruneSaves(gameId: string): Promise<void> {
    const rolling = await this.db
      .select({ id: saves.id })
      .from(saves)
      .where(and(eq(saves.gameId, gameId), eq(saves.isMilestone, false)))
      // `seq` breaks `created_at` ties deterministically (see schema.ts / memory.ts `byNewest`).
      .orderBy(desc(saves.createdAt), desc(saves.seq));
    const toDelete = rolling.slice(ROLLING_SAVES_KEPT).map((r) => r.id);
    if (toDelete.length === 0) return;
    for (const id of toDelete) {
      await this.db.delete(saves).where(eq(saves.id, id));
    }
  }
}
