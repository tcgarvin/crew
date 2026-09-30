import { describe, expect, it } from "vitest";
import { buildTestApp, mintUser, readJson } from "../test-helpers";

async function authedRequest(
  app: ReturnType<typeof buildTestApp>["app"],
  token: string,
  path: string,
  init: RequestInit = {},
) {
  return app.request(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}

describe("games", () => {
  it("creates a game and returns leaseEpoch 0", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const res = await authedRequest(app, token, "/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Freighter Run" }),
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.leaseEpoch).toBe(0);
    expect(body.game.title).toBe("Freighter Run");
    expect(body.game.savedAtTick).toBeNull();
  });

  it("lists only the caller's games", async () => {
    const { app } = buildTestApp();
    const a = await mintUser(app);
    const b = await mintUser(app);

    await authedRequest(app, a.token, "/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A's game" }),
    });
    await authedRequest(app, b.token, "/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "B's game" }),
    });

    const aList = await readJson(await authedRequest(app, a.token, "/api/games"));
    expect(aList.games).toHaveLength(1);
    expect(aList.games[0].title).toBe("A's game");

    const bList = await readJson(await authedRequest(app, b.token, "/api/games"));
    expect(bList.games).toHaveLength(1);
    expect(bList.games[0].title).toBe("B's game");
  });

  it("open bumps the lease epoch", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const created = await readJson(
      await authedRequest(app, token, "/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Freighter Run" }),
      }),
    );
    expect(created.leaseEpoch).toBe(0);

    const opened = await readJson(
      await authedRequest(app, token, `/api/games/${created.game.id}/open`, { method: "POST" }),
    );
    expect(opened.leaseEpoch).toBe(1);
    expect(opened.headSave).toBeUndefined();

    const openedAgain = await readJson(
      await authedRequest(app, token, `/api/games/${created.game.id}/open`, { method: "POST" }),
    );
    expect(openedAgain.leaseEpoch).toBe(2);
  });

  it("404s opening another user's game", async () => {
    const { app } = buildTestApp();
    const a = await mintUser(app);
    const b = await mintUser(app);
    const created = await readJson(
      await authedRequest(app, a.token, "/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "A's game" }),
      }),
    );

    const res = await authedRequest(app, b.token, `/api/games/${created.game.id}/open`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
