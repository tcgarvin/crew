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
