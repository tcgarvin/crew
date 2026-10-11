import { describe, expect, it } from "vitest";
import { crew } from "./index";
import { parsePacingArgs } from "./pacing";

describe("crew pacing: argument parsing", () => {
  it("defaults to all speeds, both scenarios and 25 s latency", () => {
    const parsed = parsePacingArgs([]);
    expect(parsed).toEqual({
      speeds: [1, 2, 4, 8],
      latencySeconds: 25,
      scenarios: ["plain", "freight"],
      json: false,
      seed: 1,
    });
  });

  it("reads --speeds, --latency, --scenario and --json", () => {
    const parsed = parsePacingArgs([
      "--speeds",
      "1,8",
      "--latency",
      "5",
      "--scenario",
      "plain",
      "--json",
    ]);
    expect(parsed).toEqual({
      speeds: [1, 8],
      latencySeconds: 5,
      scenarios: ["plain"],
      json: true,
      seed: 1,
    });
  });

  it("rejects a bad speed list through the crew() dispatcher", () => {
    const result = crew(["pacing", "--speeds", "fast"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("--speeds");
  });
});
