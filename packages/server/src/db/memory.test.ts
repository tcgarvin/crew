import { describe, expect, it } from "vitest";
import { MemoryDb } from "./memory";

async function seedGameWithCalls(db: MemoryDb, callCount: number) {
  const user = await db.createUser(`hash-${Math.random()}`);
  const game = await db.createGame(user.id, "Run");
  const save = await db.putSave({
    gameId: game.id,
    blob: Buffer.from("x"),
    schemaVersion: 1,
    simVersion: "0.1.0",
    contentHash: "c",
    savedAtTick: 0,
    isMilestone: true,
  });
  const calls = [];
  for (let i = 0; i < callCount; i += 1) {
    calls.push(
      await db.logNarratorCall({
        gameId: game.id,
        basisSaveId: save.id,
        hookKind: i % 2 === 0 ? "approachingPort" : "quietTooLong",
        model: "m",
        promptVersion: `v${i}`,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        status: i === 1 ? "error" : "ok",
        request: {},
        response: null,
        error: i === 1 ? "boom" : null,
      }),
    );
  }
  return { game, save, calls };
}

describe("MemoryDb narrator log queries", () => {
  it("lists every game, most recently updated first, with call counts and last prompt version", async () => {
    const db = new MemoryDb();
    const older = await seedGameWithCalls(db, 3);
    const newer = await seedGameWithCalls(db, 0);
    await db.bumpLease(newer.game.id);
    await db.bumpLease(older.game.id);
    const summaries = await db.listGamesWithNarratorStats();
    expect(summaries.map((s) => s.game.id)).toEqual([older.game.id, newer.game.id]);
    expect(summaries[0]).toMatchObject({ callCount: 3, lastPromptVersion: "v2" });
    expect(summaries[0]?.lastCallAt).toEqual(older.calls[2]?.createdAt);
    expect(summaries[1]).toMatchObject({ callCount: 0, lastCallAt: null, lastPromptVersion: null });
  });

  it("lists calls newest first, filtered by game, hook and status, within the limit", async () => {
    const db = new MemoryDb();
    const a = await seedGameWithCalls(db, 3);
    await seedGameWithCalls(db, 2);
    const all = await db.listNarratorCalls({ gameId: a.game.id, limit: 10 });
    expect(all.map((c) => c.promptVersion)).toEqual(["v2", "v1", "v0"]);
    const limited = await db.listNarratorCalls({ gameId: a.game.id, limit: 2 });
    expect(limited.map((c) => c.promptVersion)).toEqual(["v2", "v1"]);
    const errors = await db.listNarratorCalls({ gameId: a.game.id, status: "error", limit: 10 });
    expect(errors.map((c) => c.promptVersion)).toEqual(["v1"]);
    const quiet = await db.listNarratorCalls({ hookKind: "quietTooLong", limit: 10 });
    expect(quiet).toHaveLength(2);
  });

  it("finds calls and games by id prefix and rejects non-uuid prefixes", async () => {
    const db = new MemoryDb();
    const { game, calls } = await seedGameWithCalls(db, 1);
    const call = calls[0];
    if (call === undefined) throw new Error("seed failed");
    expect(await db.findNarratorCallsByIdPrefix(call.id.slice(0, 8))).toEqual([call]);
    expect(await db.findNarratorCallsByIdPrefix(call.id)).toEqual([call]);
    expect(
      (await db.findGamesByIdPrefix(game.id.slice(0, 6).toUpperCase())).map((g) => g.id),
    ).toEqual([game.id]);
    await expect(db.findGamesByIdPrefix("%")).rejects.toThrow(/Invalid id prefix/);
    await expect(db.findNarratorCallsByIdPrefix("")).rejects.toThrow(/Invalid id prefix/);
  });
});
