import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crew, runContentRenderDeck, runContentSchemas, runContentValidate } from "./index";

describe("crew CLI", () => {
  it("reports when no command is given", () => {
    const result = crew([]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no command given");
  });

  it("reports unknown commands", () => {
    const result = crew(["fly"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('unknown command "fly"');
  });

  it("reports unknown content subcommands", () => {
    const result = crew(["content", "launch"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('unknown subcommand "launch"');
  });
});

describe("crew content validate", () => {
  it("validates the authored bundle clean", () => {
    const result = runContentValidate();
    expect(result.output).toContain("OK");
    expect(result.exitCode).toBe(0);
  });

  it("is reachable through the crew() dispatcher", () => {
    const result = crew(["content", "validate"]);
    expect(result.exitCode).toBe(0);
  });
});

describe("crew content schemas", () => {
  it("writes one JSON schema file per def kind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crew-schemas-"));
    try {
      const result = runContentSchemas(dir);
      expect(result.exitCode).toBe(0);
      const files = readdirSync(dir);
      expect(files).toContain("deck.schema.json");
      expect(files).toContain("bundle.schema.json");
      expect(files.length).toBeGreaterThanOrEqual(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("crew content render-deck", () => {
  it("renders the freighter deck as ASCII", () => {
    const result = runContentRenderDeck("deck.freighter_mk1");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Freighter Mk1");
    expect(result.output).toContain("Legend:");
  });

  it("fails for an unknown deck id", () => {
    const result = runContentRenderDeck("deck.does_not_exist");
    expect(result.exitCode).toBe(1);
  });

  it("fails when no id is given", () => {
    const result = runContentRenderDeck(undefined);
    expect(result.exitCode).toBe(1);
  });
});
