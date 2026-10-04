import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../env";
import {
  authed,
  buildTestApp,
  createGame,
  fakeEnvelope,
  gzipEnvelope,
  mintUser,
  readJson,
  sendJson,
} from "../test-helpers";

function putBody(overrides: Record<string, unknown> = {}) {
  const envelope = fakeEnvelope(overrides.envelopeOverrides as Record<string, unknown> | undefined);
  return {
    leaseEpoch: 0,
    schemaVersion: envelope.schemaVersion,
    savedAtTick: envelope.savedAtTick,
    contentHash: envelope.contentHash,
    blob: gzipEnvelope(envelope),
    ...overrides,
  };
}

describe("saves", () => {
  it("round-trips: save then get gunzips to the same envelope", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);
    const envelope = fakeEnvelope({ savedAtTick: 42 });
    const body = {
      leaseEpoch: 0,
      schemaVersion: envelope.schemaVersion,
      savedAtTick: envelope.savedAtTick,
      contentHash: envelope.contentHash,
      blob: gzipEnvelope(envelope),
    };

    const putRes = await sendJson(app, token, "PUT", `/api/games/${game.id}/save`, body);
    expect(putRes.status).toBe(201);
    const putJson = await readJson(putRes);
    expect(putJson.savedAtTick).toBe(42);

    const getRes = await authed(app, token, `/api/games/${game.id}/save`);
    expect(getRes.status).toBe(200);
    const getJson = await readJson(getRes);
    const roundTripped = JSON.parse(
      gunzipSync(Buffer.from(getJson.blob, "base64")).toString("utf8"),
    );
    expect(roundTripped).toEqual(envelope);
  });

  it("409s a save with a stale lease epoch", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);
    // Bump the lease by opening the game.
    await authed(app, token, `/api/games/${game.id}/open`, { method: "POST" });

    const res = await sendJson(
      app,
      token,
      "PUT",
      `/api/games/${game.id}/save`,
      putBody({ leaseEpoch: 0 }),
    );
    expect(res.status).toBe(409);
    const json = await readJson(res);
    expect(json.error.code).toBe("staleLease");
  });

  it("413s a save over the size cap", async () => {
    const { app } = buildTestApp({ env: { ...loadEnv({ CREW_DB: "memory" }), maxSaveBytes: 16 } });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await sendJson(app, token, "PUT", `/api/games/${game.id}/save`, putBody());
    expect(res.status).toBe(413);
  });

  it("400s an invalid envelope", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);
    const badBlob = Buffer.from(JSON.stringify({ not: "an envelope" })).toString("base64");

    const res = await sendJson(app, token, "PUT", `/api/games/${game.id}/save`, {
      leaseEpoch: 0,
      schemaVersion: 1,
      savedAtTick: 0,
      contentHash: "x",
      blob: badBlob,
    });
    expect(res.status).toBe(400);
  });

  it("prunes non-milestone saves to the last 5, keeping all milestones", async () => {
    const { app, db } = buildTestApp();
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    // One milestone save, then 8 rolling saves.
    await sendJson(
      app,
      token,
      "PUT",
      `/api/games/${game.id}/save`,
      putBody({ milestone: true, envelopeOverrides: { savedAtTick: 0 } }),
    );
    for (let tick = 1; tick <= 8; tick++) {
      await sendJson(
        app,
        token,
        "PUT",
        `/api/games/${game.id}/save`,
        putBody({ envelopeOverrides: { savedAtTick: tick } }),
      );
    }

    const memoryDb = db as import("../db/memory").MemoryDb;
    const remaining = memoryDb.debugSavesForGame(game.id);
    const milestones = remaining.filter((s) => s.isMilestone);
    const rolling = remaining.filter((s) => !s.isMilestone);
    expect(milestones).toHaveLength(1);
    expect(rolling).toHaveLength(5);
    expect(rolling.map((s) => s.savedAtTick).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8]);
  });
});
