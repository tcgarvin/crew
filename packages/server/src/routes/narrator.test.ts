import { describe, expect, it } from "vitest";
import { loadEnv } from "../env";
import { buildTestApp, echoNarrator, fakeEnvelope, mintUser, readJson } from "../test-helpers";

async function authed(
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

async function createGame(app: ReturnType<typeof buildTestApp>["app"], token: string) {
  const res = await authed(app, token, "/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Freighter Run" }),
  });
  return (await res.json()) as { game: { id: string } };
}

function narratorBody(gameId: string, savedAtTick = 0) {
  return {
    gameId,
    hook: { kind: "approachingPort" },
    snapshot: fakeEnvelope({ savedAtTick }),
    recentEvents: [],
  };
}

describe("narrator", () => {
  it("calls the injected narrator and logs the call", async () => {
    const env = loadEnv({ CREW_DB: "memory" });
    const { app, db } = buildTestApp({ env, runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id)),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.commands).toEqual([]);
    expect(body.notesUpdate).toBe("updated notes");

    const lastCall = await db.getLastNarratorCall(game.id);
    expect(lastCall?.status).toBe("ok");
  });

  it("429s once the hourly call budget is exceeded, and logs the rejection", async () => {
    const env = loadEnv({ CREW_DB: "memory", CREW_NARRATOR_MAX_CALLS_PER_HOUR: "1" });
    const { app, db } = buildTestApp({ env, runNarrator: echoNarrator });
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const first = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id, 0)),
    });
    expect(first.status).toBe(200);

    const second = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(narratorBody(game.id, 500)),
    });
    expect(second.status).toBe(429);
    const secondBody = await readJson(second);
    expect(secondBody.error.code).toBe("budgetExceeded");

    const lastCall = await db.getLastNarratorCall(game.id);
    expect(lastCall?.status).toBe("budgetExceeded");
  });

  it("400s an invalid narrator request", async () => {
    const { app } = buildTestApp();
    const { token } = await mintUser(app);
    const { game } = await createGame(app, token);

    const res = await authed(app, token, `/api/games/${game.id}/narrator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: game.id, hook: {} }),
    });
    expect(res.status).toBe(400);
  });
});
