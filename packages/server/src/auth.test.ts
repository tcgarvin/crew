import { describe, expect, it } from "vitest";
import { buildTestApp, mintUser, readJson } from "./test-helpers";

describe("auth", () => {
  it("mints an anon token and resolves it as a bearer", async () => {
    const { app } = buildTestApp();
    const { userId, token } = await mintUser(app);
    expect(userId).toBeTruthy();
    expect(token).toBeTruthy();

    const res = await app.request("/api/games", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("401s without a token", async () => {
    const { app } = buildTestApp();
    const res = await app.request("/api/games");
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.code).toBe("unauthorized");
  });

  it("401s with an unknown token", async () => {
    const { app } = buildTestApp();
    const res = await app.request("/api/games", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});
