/**
 * In-memory `Db` fake (W8). Used in dev (`CREW_DB=memory`) and in every unit test, so tests run
 * fully offline. Mirrors the pruning and lease semantics of the real Neon-backed `Db` exactly.
 */
import { randomUUID } from "node:crypto";
import {
  type Db,
  type FinishNarratorCallInput,
  type GameNarratorSummary,
  type GameRow,
  type LogNarratorCallInput,
  type NarratorCallFilter,
  type NarratorCallKind,
  type NarratorCallRow,
  type PutSaveInput,
  type SaveRow,
  type UserRow,
  assertIdPrefix,
  narratorCallKind,
} from "./types";

const ROLLING_SAVES_KEPT = 5;

/**
 * Compares rows newest-first by `(createdAt, seq)`. `createdAt` has millisecond resolution and
 * several rows can land in the same tick (e.g. a tight test loop, or batched writes); `seq` is a
 * per-table monotonic counter assigned at insert time, so ties always resolve to true insertion
 * order. Mirrors `ORDER BY created_at DESC, seq DESC` in `queries.ts`.
 */
function byNewest(
  a: { createdAt: Date; seq: number },
  b: { createdAt: Date; seq: number },
): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return b.seq - a.seq;
}

export class MemoryDb implements Db {
  private readonly users = new Map<string, UserRow>();
  private readonly games = new Map<string, GameRow>();
  private readonly saves = new Map<string, SaveRow>();
  private readonly narratorCalls = new Map<string, NarratorCallRow>();
  private nextSaveSeq = 1;
  private nextNarratorCallSeq = 1;

  async createUser(anonTokenHash: string): Promise<UserRow> {
    const row: UserRow = { id: randomUUID(), anonTokenHash, createdAt: new Date() };
    this.users.set(row.id, row);
    return row;
  }

  async getUserByTokenHash(anonTokenHash: string): Promise<UserRow | undefined> {
    for (const user of this.users.values()) {
      if (user.anonTokenHash === anonTokenHash) return user;
    }
    return undefined;
  }

  async createGame(userId: string, name: string): Promise<GameRow> {
    const now = new Date();
    const row: GameRow = {
      id: randomUUID(),
      userId,
      name,
      headSaveId: null,
      leaseEpoch: 0,
      narrativeNotes: {},
      createdAt: now,
      updatedAt: now,
    };
    this.games.set(row.id, row);
    return row;
  }

  async listGames(userId: string): Promise<readonly GameRow[]> {
    return [...this.games.values()].filter((g) => g.userId === userId);
  }

  async getGame(gameId: string): Promise<GameRow | undefined> {
    return this.games.get(gameId);
  }

  async bumpLease(gameId: string): Promise<GameRow> {
    const game = this.requireGame(gameId);
    const updated: GameRow = { ...game, leaseEpoch: game.leaseEpoch + 1, updatedAt: new Date() };
    this.games.set(gameId, updated);
    return updated;
  }

  async putSave(input: PutSaveInput): Promise<SaveRow> {
    const game = this.requireGame(input.gameId);
    const row: SaveRow = {
      id: randomUUID(),
      ...input,
      createdAt: new Date(),
      seq: this.nextSaveSeq++,
    };
    this.saves.set(row.id, row);
    this.games.set(input.gameId, { ...game, headSaveId: row.id, updatedAt: new Date() });
    this.pruneSaves(input.gameId);
    return row;
  }

  async getSave(saveId: string): Promise<SaveRow | undefined> {
    return this.saves.get(saveId);
  }

  async getHeadSave(gameId: string): Promise<SaveRow | undefined> {
    const game = this.games.get(gameId);
    if (!game?.headSaveId) return undefined;
    return this.saves.get(game.headSaveId);
  }

  async updateNotes(gameId: string, narrativeNotes: unknown): Promise<void> {
    const game = this.requireGame(gameId);
    this.games.set(gameId, { ...game, narrativeNotes, updatedAt: new Date() });
  }

  async logNarratorCall(input: LogNarratorCallInput): Promise<NarratorCallRow> {
    const row: NarratorCallRow = {
      id: randomUUID(),
      createdAt: new Date(),
      seq: this.nextNarratorCallSeq++,
      ...input,
    };
    this.narratorCalls.set(row.id, row);
    return row;
  }

  async finishNarratorCall(id: string, input: FinishNarratorCallInput): Promise<void> {
    const row = this.narratorCalls.get(id);
    if (row === undefined) throw new Error(`finishNarratorCall: no narrator call ${id}`);
    this.narratorCalls.set(id, { ...row, ...input });
  }

  async countNarratorCallsSince(
    gameId: string,
    sinceMs: number,
    kind: NarratorCallKind,
  ): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    let count = 0;
    for (const call of this.narratorCalls.values()) {
      if (call.status === "budgetExceeded") continue; // rejections never reached the model (D43)
      if (narratorCallKind(call.hookKind) !== kind) continue; // D67: one budget per kind
      if (call.gameId === gameId && call.createdAt.getTime() >= cutoff) count += 1;
    }
    return count;
  }

  async getLastNarratorCall(gameId: string): Promise<NarratorCallRow | undefined> {
    let latest: NarratorCallRow | undefined;
    for (const call of this.narratorCalls.values()) {
      if (call.gameId !== gameId) continue;
      if (!latest || byNewest(call, latest) < 0) latest = call;
    }
    return latest;
  }

  async listGamesWithNarratorStats(): Promise<readonly GameNarratorSummary[]> {
    const ordered = [...this.games.values()].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    const summaries: GameNarratorSummary[] = [];
    for (const game of ordered) {
      const calls = [...this.narratorCalls.values()]
        .filter((c) => c.gameId === game.id)
        .sort(byNewest);
      const last = calls[0];
      summaries.push({
        game,
        callCount: calls.length,
        lastCallAt: last?.createdAt ?? null,
        lastPromptVersion: last?.promptVersion ?? null,
      });
    }
    return summaries;
  }

  async listNarratorCalls(filter: NarratorCallFilter): Promise<readonly NarratorCallRow[]> {
    return [...this.narratorCalls.values()]
      .filter(
        (c) =>
          (filter.gameId === undefined || c.gameId === filter.gameId) &&
          (filter.hookKind === undefined || c.hookKind === filter.hookKind) &&
          (filter.status === undefined || c.status === filter.status) &&
          (filter.kind === undefined || narratorCallKind(c.hookKind) === filter.kind),
      )
      .sort(byNewest)
      .slice(0, filter.limit);
  }

  async findNarratorCallsByIdPrefix(prefix: string): Promise<readonly NarratorCallRow[]> {
    assertIdPrefix(prefix);
    const lower = prefix.toLowerCase();
    return [...this.narratorCalls.values()].filter((c) => c.id.startsWith(lower)).sort(byNewest);
  }

  async findGamesByIdPrefix(prefix: string): Promise<readonly GameRow[]> {
    assertIdPrefix(prefix);
    const lower = prefix.toLowerCase();
    return [...this.games.values()].filter((g) => g.id.startsWith(lower));
  }

  private requireGame(gameId: string): GameRow {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`No such game: ${gameId}`);
    return game;
  }

  private pruneSaves(gameId: string): void {
    const gameSaves = [...this.saves.values()].filter((s) => s.gameId === gameId).sort(byNewest);
    let rollingSeen = 0;
    for (const save of gameSaves) {
      if (save.isMilestone) continue;
      rollingSeen += 1;
      if (rollingSeen > ROLLING_SAVES_KEPT) this.saves.delete(save.id);
    }
  }

  /** Test-only inspection hook; not part of the `Db` interface. */
  debugSavesForGame(gameId: string): readonly SaveRow[] {
    return [...this.saves.values()].filter((s) => s.gameId === gameId);
  }
}
