import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HULL_CLASS_BOX, dockWalkableMask, loadBundle, shipAtInBerth } from "@crew/content";
import { type DockDefId, HULL_SIZE_BOX, berthPlacement, dockFloorMask } from "@crew/sim";
import { describe, expect, it } from "vitest";
import {
  crew,
  dockFileStem,
  dockGraftIssues,
  docksDir,
  runContentRenderDeck,
  runContentRenderDock,
  runContentSchemas,
  runContentValidate,
} from "./index";
import { renderDockReadme } from "./render-dock";

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

function authoredBundle() {
  const result = loadBundle();
  if (!result.ok) throw new Error("content bundle failed validation");
  return result.bundle;
}

describe("crew content render-dock", () => {
  it("renders a dock with the ship composited and writes its README", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crew-docks-"));
    try {
      const result = runContentRenderDock("dock.crossroads_hub", dir);
      expect(result.exitCode).toBe(0);
      const readme = readFileSync(path.join(dir, "crossroads-hub.README.md"), "utf8");
      expect(readme).toContain("Freighter Mk1 (deck.freighter_mk1) docked at (3,3)");
      expect(readme).toContain("regular: Hal Petrosyan");
      expect(readme).toContain("personnel_ramp: (32,21)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails for an unknown dock id or none", () => {
    expect(runContentRenderDock("dock.nowhere").exitCode).toBe(1);
    expect(runContentRenderDock(undefined).exitCode).toBe(1);
  });

  it("has an up-to-date README next to every authored dock", () => {
    const bundle = authoredBundle();
    const decks = Object.values(bundle.decks);
    for (const dock of Object.values(bundle.docks ?? {})) {
      const port = bundle.ports[dock.portId];
      if (port === undefined) throw new Error(`no port ${dock.portId}`);
      const stem = dockFileStem(dock.id);
      const committed = readFileSync(path.join(docksDir(), `${stem}.README.md`), "utf8");
      expect(committed, `${stem}.README.md is stale: crew content render-dock ${dock.id}`).toBe(
        renderDockReadme(dock, decks, port, `${stem}.json`),
      );
    }
  });
});

describe("dock maps: content validation and the sim's nav graft agree", () => {
  it("see the same walkable tiles on every authored dock", () => {
    const docks = Object.values(authoredBundle().docks ?? {});
    expect(docks.length).toBeGreaterThan(0);
    for (const dock of docks) {
      expect([...dockWalkableMask(dock)], dock.id).toEqual([...dockFloorMask(dock)]);
    }
  });

  it("place every deck in every berth box alike (D72)", () => {
    expect(HULL_CLASS_BOX).toEqual(HULL_SIZE_BOX);
    const bundle = authoredBundle();
    for (const dock of Object.values(bundle.docks ?? {})) {
      for (const deck of Object.values(bundle.decks)) {
        expect(shipAtInBerth(dock, deck), `${dock.id} ${deck.id}`).toEqual(
          berthPlacement(dock, deck),
        );
      }
    }
  });

  it("grafts every authored dock onto the deck", () => {
    expect(dockGraftIssues(authoredBundle())).toEqual([]);
  });

  it("reports a dock the sim cannot graft", () => {
    const bundle = authoredBundle();
    const hub = bundle.docks?.["dock.crossroads_hub" as DockDefId];
    if (hub === undefined) throw new Error("no hub dock");
    // Floor over the whole berth box: the graft overlaps the deck.
    const box = HULL_SIZE_BOX[hub.berth.sizeClass];
    const { origin } = hub.berth;
    const flooded = {
      ...hub,
      rows: hub.rows.map((row, y) =>
        y < origin.y || y >= origin.y + box.h
          ? row
          : row.slice(0, origin.x) + ".".repeat(box.w) + row.slice(origin.x + box.w),
      ),
    };
    expect(dockGraftIssues({ ...bundle, docks: { [hub.id]: flooded } })).toEqual([
      expect.stringContaining("overlaps deck"),
    ]);
  });
});
