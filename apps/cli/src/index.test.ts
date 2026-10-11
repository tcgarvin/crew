import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HULL_CLASS_BOX,
  dockRampLandings,
  dockWalkableMask,
  loadBundle,
  shipAtInBerth,
  validatePhysical,
} from "@crew/content";
import {
  type ContentBundle,
  type DeckDef,
  type DeckDefId,
  type DockDefId,
  type DoorPlacementDef,
  HULL_SIZE_BOX,
  berthPlacement,
  checkDockFitsDeck,
  dockFloorMask,
} from "@crew/sim";
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

  it("lists the activities Mk1 has no venue for as notes, still OK (§activities-and-interests)", () => {
    const result = runContentValidate();
    expect(result.exitCode).toBe(0);
    const notes = result.output.split("\n").filter((line) => line.startsWith("  [note] "));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((line) => line.startsWith("  [note] decks.deck.freighter_mk1: "))).toBe(
      true,
    );
    expect(result.output).toContain('no venue for "activity.cards"');
    expect(result.output).not.toContain("decks.deck.freighter_mk2");
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
      expect(readme).toContain("Freighter Mk1 (deck.freighter_mk1) docked at (4,3)");
      expect(readme).toContain("regular: Hal Petrosyan");
      expect(readme).toContain("personnel_ramp: (33,21)");
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

  it("place every deck in every berth box alike (§berth-boxes)", () => {
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
    // The graft is checked against every deck, so each one reports the overlap.
    const issues = dockGraftIssues({ ...bundle, docks: { [hub.id]: flooded } });
    expect(issues).toHaveLength(Object.keys(bundle.decks).length);
    for (const deckId of Object.keys(bundle.decks)) {
      expect(issues).toContainEqual(
        expect.stringMatching(new RegExp(`on ${deckId}: .*overlaps deck`)),
      );
    }
  });
});

function rampDoor(key: string, x: number): DoorPlacementDef {
  return {
    key,
    edge: { x, y: 19, side: "s" },
    kind: "ramp",
    manualOperationSupported: true,
    initialState: "closed",
  };
}

/**
 * Freighter Mk2's footprint with nothing inside (ship life §8): 36 x 20, the cargo ramp at
 * (13,19) and the personnel ramp at (34,19), both on the south hull, each with its transfer tile
 * just inside. Lets the dock maps be checked against the M box's full-size ship before that deck
 * is authored.
 */
const mk2Footprint: DeckDef = {
  id: "deck.mk2_footprint" as DeckDefId,
  name: "Freighter Mk2 footprint (test stub)",
  width: 36,
  height: 20,
  tiles: Array.from({ length: 20 }, () => "H".repeat(36)),
  compartments: [{ key: "hold", symbol: "H", name: "Hold", tags: ["cargoHold"] }],
  doors: [rampDoor("cargo_ramp", 13), rampDoor("personnel_ramp", 34)],
  openings: [],
  walls: [],
  machines: [],
  powerDomains: [],
  zones: [],
  docking: {
    cargoRampDoorKey: "cargo_ramp",
    personnelRampDoorKey: "personnel_ramp",
    cargoTransferTiles: [{ x: 13, y: 18 }],
    personnelTransferTiles: [{ x: 34, y: 18 }],
  },
  spawnPoints: [],
  hull: { class: "light_freighter", sizeClass: "M", max: 100 },
};

describe("dock maps take both M-class footprints (§berth-boxes)", () => {
  const authored = authoredBundle();
  const withMk2: ContentBundle = {
    ...authored,
    decks: { ...authored.decks, [mk2Footprint.id]: mk2Footprint },
  };
  const docks = Object.values(authored.docks ?? {});

  it("has the Mk1 deck and the Mk2 stub to check against", () => {
    expect(Object.keys(withMk2.decks)).toEqual(
      expect.arrayContaining(["deck.freighter_mk1", mk2Footprint.id]),
    );
    expect(docks.length).toBe(8);
  });

  it("lays every map out round an M box: 2-tile side margins, a quay below, under 44 x 30", () => {
    for (const dock of docks) {
      const box = HULL_CLASS_BOX[dock.berth.sizeClass];
      const { origin } = dock.berth;
      expect(dock.berth.sizeClass, dock.id).toBe("M");
      expect(origin.x, dock.id).toBeGreaterThanOrEqual(2);
      expect(dock.width - (origin.x + box.w), dock.id).toBeGreaterThanOrEqual(2);
      expect(dock.width, dock.id).toBeLessThanOrEqual(44);
      expect(dock.height, dock.id).toBeLessThanOrEqual(30);
      expect(dock.height - (origin.y + box.h), dock.id).toBeGreaterThanOrEqual(6);
    }
  });

  it("puts walkable floor along the whole quay row, so any ramp in the box lands", () => {
    for (const dock of docks) {
      const box = HULL_CLASS_BOX[dock.berth.sizeClass];
      const { origin } = dock.berth;
      const mask = dockWalkableMask(dock);
      const quayY = origin.y + box.h;
      for (let x = origin.x; x < origin.x + box.w; x++) {
        expect(mask[quayY * dock.width + x], `${dock.id} (${x},${quayY})`).toBe(1);
      }
    }
  });

  it("lands the Mk2 stub's ramps at box x + 13 and box x + 34 on the quay row", () => {
    for (const dock of docks) {
      const { origin } = dock.berth;
      expect(dockRampLandings(dock, mk2Footprint), dock.id).toEqual([
        { key: "cargo_ramp", tile: { x: origin.x + 13, y: origin.y + 20 } },
        { key: "personnel_ramp", tile: { x: origin.x + 34, y: origin.y + 20 } },
      ]);
    }
  });

  it("grafts every map onto both decks in the sim", () => {
    for (const dock of docks) {
      for (const deck of Object.values(withMk2.decks)) {
        expect(
          () => checkDockFitsDeck(withMk2, deck.id, dock.id),
          `${dock.id} ${deck.id}`,
        ).not.toThrow();
      }
    }
  });

  it("passes the dock checks with both decks docked: landings, posts and areas reached", () => {
    const dockIssues = validatePhysical(withMk2).filter((i) => i.path[0] === "docks");
    expect(dockIssues).toEqual([]);
  });
});
