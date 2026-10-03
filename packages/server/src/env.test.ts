import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_NARRATOR_MODEL, loadEnv } from "./env";

describe("loadEnv", () => {
  it("defaults the narrator model when CREW_NARRATOR_MODEL is unset or empty", () => {
    expect(loadEnv({}).narratorModel).toBe(DEFAULT_SERVER_NARRATOR_MODEL);
    expect(loadEnv({ CREW_NARRATOR_MODEL: "" }).narratorModel).toBe(DEFAULT_SERVER_NARRATOR_MODEL);
    expect(DEFAULT_SERVER_NARRATOR_MODEL).toBe("anthropic/claude-sonnet-4.6");
  });

  it("uses CREW_NARRATOR_MODEL when set, and passes the key and database URL through", () => {
    const env = loadEnv({
      CREW_NARRATOR_MODEL: "anthropic/claude-opus-4.6",
      OPENROUTER_API_KEY: "k",
      DATABASE_URL: "postgres://x",
    });
    expect(env.narratorModel).toBe("anthropic/claude-opus-4.6");
    expect(env.openRouterApiKey).toBe("k");
    expect(env.databaseUrl).toBe("postgres://x");
  });
});

describe("loadEnv narrator budget", () => {
  it("defaults the hourly call cap to 30, enough for a passage (passengers-and-galaxy §8.6)", () => {
    expect(loadEnv({}).narratorMaxCallsPerHour).toBe(30);
    expect(loadEnv({ CREW_NARRATOR_MAX_CALLS_PER_HOUR: "6" }).narratorMaxCallsPerHour).toBe(6);
  });
});

describe("loadEnv narrator fallback (D43)", () => {
  it("defaults to error in production and null elsewhere", () => {
    expect(loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://x" }).narratorFallback).toBe(
      "error",
    );
    expect(loadEnv({ NODE_ENV: "development" }).narratorFallback).toBe("null");
    expect(loadEnv({ NODE_ENV: "test" }).narratorFallback).toBe("null");
    expect(loadEnv({}).narratorFallback).toBe("null");
  });

  it("honours CREW_NARRATOR_FALLBACK in either environment and rejects other values", () => {
    expect(loadEnv({ CREW_NARRATOR_FALLBACK: "error" }).narratorFallback).toBe("error");
    expect(
      loadEnv({ NODE_ENV: "production", CREW_DB: "memory", CREW_NARRATOR_FALLBACK: "null" })
        .narratorFallback,
    ).toBe("null");
    expect(loadEnv({ CREW_NARRATOR_FALLBACK: "" }).narratorFallback).toBe("null");
    expect(() => loadEnv({ CREW_NARRATOR_FALLBACK: "template" })).toThrow(/CREW_NARRATOR_FALLBACK/);
  });
});
