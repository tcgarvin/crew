/**
 * In-memory `Db` fake (W8). Used in dev (`CREW_DB=memory`) and in every unit test, so tests run
 * fully offline. Mirrors the pruning and lease semantics of the real Neon-backed `Db` exactly.
 */
import { randomUUID } from "node:crypto";
import type {
  Db,
  GameRow,
  LogNarratorCallInput,
  NarratorCallRow,
  PutSaveInput,
  SaveRow,
  UserRow,
} from "./types";

const ROLLING_SAVES_KEPT = 5;

export class MemoryDb implements Db {
  private readonly users = new Map<string, UserRow>();
  private readonly games = new Map<string, GameRow>();
  private readonly saves = new Map<string, SaveRow>();
  private readonly narratorCalls = new Map<string, NarratorCallRow>();

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
      gameId: input.gameId,
      blob: input.blob,
      schemaVersion: input.schemaVersion,
      simVersion: input.simVersion,
      contentHash: input.contentHash,
      savedAtTick: input.savedAtTick,
      isMilestone: input.isMilestone,
      createdAt: new Date(),
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
    const row: NarratorCallRow = { id: randomUUID(), createdAt: new Date(), ...input };
    this.narratorCalls.set(row.id, row);
    return row;
  }

  async countNarratorCallsSince(gameId: string, sinceMs: number): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    let count = 0;
    for (const call of this.narratorCalls.values()) {
      if (call.gameId === gameId && call.createdAt.getTime() >= cutoff) count += 1;
    }
    return count;
  }

  async getLastNarratorCall(gameId: string): Promise<NarratorCallRow | undefined> {
    let latest: NarratorCallRow | undefined;
    for (const call of this.narratorCalls.values()) {
      if (call.gameId !== gameId) continue;
      if (!latest || call.createdAt.getTime() > latest.createdAt.getTime()) latest = call;
    }
    return latest;
  }

  private requireGame(gameId: string): GameRow {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`No such game: ${gameId}`);
    return game;
  }

  private pruneSaves(gameId: string): void {
    const gameSaves = [...this.saves.values()]
      .filter((s) => s.gameId === gameId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
