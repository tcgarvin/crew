import {
  DEFAULT_MAX_REPAIRS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_NARRATOR_MODEL,
  DEFAULT_NARRATOR_REASONING_EFFORT,
  STAGING_TIMEOUT_MS,
} from "@crew/narrator";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("defaults the narrator model when CREW_NARRATOR_MODEL is unset or empty", () => {
    expect(loadEnv({}).narratorModel).toBe(DEFAULT_NARRATOR_MODEL);
    expect(loadEnv({ CREW_NARRATOR_MODEL: "" }).narratorModel).toBe(DEFAULT_NARRATOR_MODEL);
    expect(DEFAULT_NARRATOR_MODEL).toBe("openai/gpt-6-luna");
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

describe("loadEnv staging model (§staging-call-on-the-server)", () => {
  it("follows the story model unless CREW_STAGING_MODEL is set", () => {
    expect(loadEnv({}).stagingModel).toBe(DEFAULT_NARRATOR_MODEL);
    expect(loadEnv({ CREW_NARRATOR_MODEL: "a/story" }).stagingModel).toBe("a/story");
    expect(loadEnv({ CREW_NARRATOR_MODEL: "a/story", CREW_STAGING_MODEL: "" }).stagingModel).toBe(
      "a/story",
    );
    const env = loadEnv({ CREW_NARRATOR_MODEL: "a/story", CREW_STAGING_MODEL: "b/cheap" });
    expect(env.stagingModel).toBe("b/cheap");
    expect(env.narratorModel).toBe("a/story");
  });
});

describe("loadEnv reasoning effort (§models-and-reasoning-effort)", () => {
  it("defaults to the narrator's effort and lets staging follow the story call unless set", () => {
    expect(DEFAULT_NARRATOR_REASONING_EFFORT).toBe("low");
    expect(loadEnv({}).narratorReasoningEffort).toBe("low");
    expect(loadEnv({}).stagingReasoningEffort).toBe("low");
    const story = loadEnv({ CREW_NARRATOR_REASONING_EFFORT: "low" });
    expect(story.narratorReasoningEffort).toBe("low");
    expect(story.stagingReasoningEffort).toBe("low");
    const both = loadEnv({
      CREW_NARRATOR_REASONING_EFFORT: "low",
      CREW_STAGING_REASONING_EFFORT: "minimal",
    });
    expect(both.stagingReasoningEffort).toBe("minimal");
  });

  it("refuses an effort OpenRouter does not know", () => {
    expect(() => loadEnv({ CREW_NARRATOR_REASONING_EFFORT: "lowest" })).toThrow(
      /CREW_NARRATOR_REASONING_EFFORT/,
    );
  });
});

describe("loadEnv staging timeout (§narrator-timeouts)", () => {
  it("defaults to the narrator's 10 s staging timeout and reads CREW_STAGING_TIMEOUT_MS", () => {
    expect(loadEnv({}).stagingTimeoutMs).toBe(STAGING_TIMEOUT_MS);
    expect(STAGING_TIMEOUT_MS).toBe(10_000);
    expect(loadEnv({ CREW_STAGING_TIMEOUT_MS: "8000" }).stagingTimeoutMs).toBe(8000);
    expect(() => loadEnv({ CREW_STAGING_TIMEOUT_MS: "soon" })).toThrow(/CREW_STAGING_TIMEOUT_MS/);
  });
});

describe("loadEnv narrator repairs (§repair-turn)", () => {
  it("defaults to the narrator's two repairs and reads CREW_NARRATOR_REPAIRS, zero included", () => {
    expect(loadEnv({}).narratorRepairs).toBe(DEFAULT_MAX_REPAIRS);
    expect(DEFAULT_MAX_REPAIRS).toBe(2);
    expect(loadEnv({ CREW_NARRATOR_REPAIRS: "0" }).narratorRepairs).toBe(0);
    expect(loadEnv({ CREW_NARRATOR_REPAIRS: "3" }).narratorRepairs).toBe(3);
    expect(() => loadEnv({ CREW_NARRATOR_REPAIRS: "-1" })).toThrow(/CREW_NARRATOR_REPAIRS/);
    expect(() => loadEnv({ CREW_NARRATOR_REPAIRS: "1.5" })).toThrow(/CREW_NARRATOR_REPAIRS/);
  });
});

describe("loadEnv notes-turn tool rounds (§notes-turn-tools)", () => {
  it("defaults to the narrator's four rounds and reads CREW_NARRATOR_TOOL_ROUNDS, zero included", () => {
    expect(loadEnv({}).narratorToolRounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(DEFAULT_MAX_TOOL_ROUNDS).toBe(4);
    expect(loadEnv({ CREW_NARRATOR_TOOL_ROUNDS: "0" }).narratorToolRounds).toBe(0);
    expect(loadEnv({ CREW_NARRATOR_TOOL_ROUNDS: "2" }).narratorToolRounds).toBe(2);
    expect(() => loadEnv({ CREW_NARRATOR_TOOL_ROUNDS: "-1" })).toThrow(/CREW_NARRATOR_TOOL_ROUNDS/);
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
