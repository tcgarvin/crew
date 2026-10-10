import type { DeckDef, MachineTag } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { deckDefSchema } from "./deck";
import type { ValidationIssue } from "./issues";
import { scenarioDefSchema } from "./scenario";
import {
  type MachineTagTable,
  checkHullContract,
  checkScenarioBeds,
  checkScenarioCrewSpawns,
} from "./validate-hull";

type Position = MachineTagTable[string]["interactionPositions"][number];

const position = (key: string, purposes: Position["purposes"], y = 0): Position => ({
  key,
  offset: { x: -1, y },
  purposes,
  capacity: 1,
});

/** The helm's seat and, apart from it, the standby tile the oncoming waits on (§handover). */
const HELM_POSITIONS = [position("seat", ["operate", "repair"]), position("standby", ["use"])];

/** Four seats at one table (§what-a-deck-must-offer). */
const TABLE_SEATS = [0, 1, 2, 3].map((y) => position(`seat_${y}`, ["use"], y));

const tagged = (tag: MachineTag, interactionPositions = [position("front", ["use"])]) => ({
  tags: [tag],
  interactionPositions,
});

const MACHINES: MachineTagTable = {
  "machine.engine": tagged("engine"),
  "machine.pump": tagged("cooling"),
  "machine.stove": tagged("stove"),
  "machine.table": tagged("messTable", TABLE_SEATS),
  "machine.bunk": tagged("bed"),
  "machine.medbed": tagged("medBed"),
  "machine.helm": tagged("pilotStation", HELM_POSITIONS),
  "machine.nav": tagged("navStation"),
};

const door = (key: string, x: number, y: number, side: string, kind = "interior") => ({
  key,
  edge: { x, y, side },
  kind,
  manualOperationSupported: true,
  initialState: "closed",
});

const placed = (key: string, machineDefId: string, x: number) => ({
  key,
  machineDefId,
  origin: { x, y: 0 },
  rotation: 270,
});

/**
 * The smallest deck that meets the hull contract, bow east, quay south:
 *
 *     EEGGQQBB     E engineering, G galley and mess, Q quarters, B bridge
 *     EEGGQQBB     H hold, A airlock; ramps on the bottom edge at x 1 (cargo)
 *     HHHHHAAB     and x 5 (personnel)
 */
const RAW_DECK = {
  id: "deck.test.hull",
  name: "Contract deck",
  width: 8,
  height: 3,
  tiles: ["EEGGQQBB", "EEGGQQBB", "HHHHHAAB"],
  compartments: [
    { key: "hold", symbol: "H", name: "Hold", tags: ["cargoHold"] },
    { key: "engineering", symbol: "E", name: "Engineering", tags: ["engineering"] },
    { key: "galley", symbol: "G", name: "Galley", tags: ["galley", "mess"] },
    { key: "quarters", symbol: "Q", name: "Quarters", tags: ["quarters"] },
    { key: "bridge", symbol: "B", name: "Bridge", tags: ["bridge"] },
    { key: "airlock", symbol: "A", name: "Airlock", tags: ["airlock"] },
  ],
  doors: [
    door("d1", 1, 0, "e"),
    door("d2", 3, 1, "e"),
    door("d3", 5, 1, "e"),
    door("d4", 0, 1, "s"),
    door("d5", 4, 2, "e"),
    door("cargo_ramp", 1, 2, "s", "ramp"),
    door("personnel_ramp", 5, 2, "s", "ramp"),
  ],
  openings: [],
  walls: [],
  machines: [
    placed("engine_1", "machine.engine", 0),
    placed("pump_1", "machine.pump", 1),
    placed("stove_1", "machine.stove", 2),
    placed("table_1", "machine.table", 3),
    placed("bunk_1", "machine.bunk", 4),
    placed("bunk_2", "machine.bunk", 5),
    placed("helm_1", "machine.helm", 6),
    placed("nav_1", "machine.nav", 7),
  ],
  powerDomains: [],
  zones: [
    { key: "stow", name: "Stowage", tags: ["cargoStowage"], tiles: [{ x: 2, y: 2 }] },
    { key: "pantry", name: "Pantry", tags: ["pantry"], tiles: [{ x: 0, y: 2 }] },
    // the stove's use tile is (2,1), so (1,1) is beside it
    { key: "serving", name: "Serving", tags: ["serving"], tiles: [{ x: 1, y: 1 }] },
    { key: "mops", name: "Mops", tags: ["cleaningLocker"], tiles: [{ x: 4, y: 2 }] },
  ],
  docking: {
    cargoRampDoorKey: "cargo_ramp",
    personnelRampDoorKey: "personnel_ramp",
    cargoTransferTiles: [{ x: 1, y: 2 }],
    personnelTransferTiles: [{ x: 5, y: 2 }],
  },
  hull: { class: "test_hull", sizeClass: "S", max: 100 },
  spawnPoints: [
    { key: "crew_1", tile: { x: 3, y: 2 }, tags: ["crew"] },
    { key: "passenger_1", tile: { x: 6, y: 2 }, tags: ["passenger"] },
  ],
};

type RawDeck = typeof RAW_DECK;

/** The contract deck with `edit` applied, parsed so it carries the sim's types. */
function deckWith(edit: (deck: RawDeck) => void = () => {}): DeckDef {
  const raw = structuredClone(RAW_DECK);
  edit(raw);
  return deckDefSchema.parse(raw);
}

function format(issues: readonly ValidationIssue[]): string[] {
  return issues.map((i) => `${i.level} ${i.path.join(".")}: ${i.message}`);
}

function hullMessages(
  edit?: (deck: RawDeck) => void,
  machines: MachineTagTable = MACHINES,
): string[] {
  const issues: ValidationIssue[] = [];
  checkHullContract(deckWith(edit), machines, issues);
  return format(issues);
}

const AT = "physical decks.deck.test.hull";

function withoutTag(deck: RawDeck, tag: string): void {
  for (const c of deck.compartments) c.tags = c.tags.filter((t) => t !== tag);
}

describe("hull contract (§what-a-deck-must-offer)", () => {
  it("accepts a deck that meets it", () => {
    expect(hullMessages()).toEqual([]);
  });

  it("rejects a deck larger than its size class box", () => {
    const messages = hullMessages((deck) => {
      deck.width = 25;
      deck.tiles = deck.tiles.map((row) => row.padStart(25, " "));
    });
    expect(messages).toEqual([`${AT}.hull.sizeClass: 25 x 3 exceeds the S box (24 x 14)`]);
  });

  it("rejects a bridge that does not reach the east hull edge", () => {
    const messages = hullMessages((deck) => {
      deck.tiles = ["EEGGQQBA", "EEGGQQBA", "HHHHHAAA"];
    });
    expect(messages).toEqual([
      `${AT}.compartments: the bridge does not reach the east hull edge (x = 7); the bow is east`,
    ]);
  });

  it("rejects a ramp door that does not face south", () => {
    const messages = hullMessages((deck) => {
      deck.doors = deck.doors.map((d) =>
        d.key === "personnel_ramp" ? { ...d, edge: { ...d.edge, side: "e" } } : d,
      );
    });
    expect(messages).toEqual([
      `${AT}.doors.6.edge: ramp door "personnel_ramp" faces e; ramps face the quay, side s`,
    ]);
  });

  it("rejects a south-facing ramp door above the bottom row", () => {
    const messages = hullMessages((deck) => {
      deck.doors = deck.doors.map((d) =>
        d.key === "cargo_ramp" ? { ...d, edge: { ...d.edge, y: 1 } } : d,
      );
    });
    expect(messages).toEqual([
      `${AT}.doors.5.edge: ramp door "cargo_ramp" is on row 1, not the bottom row 2`,
    ]);
  });

  it("rejects a transfer tile neither at nor beside its ramp door", () => {
    const messages = hullMessages((deck) => {
      deck.docking.cargoTransferTiles = [{ x: 3, y: 2 }];
    });
    expect(messages).toEqual([
      `${AT}.docking.cargoTransferTiles.0: cargo transfer tile (3,2) is not at or beside ramp door "cargo_ramp" (1,2)`,
    ]);
  });

  it("accepts a transfer tile beside its ramp door", () => {
    expect(
      hullMessages((deck) => {
        deck.docking.personnelTransferTiles = [{ x: 6, y: 2 }];
      }),
    ).toEqual([]);
  });

  it.each(["bridge", "mess", "galley", "engineering", "cargoHold", "airlock"])(
    "requires a compartment tagged %s",
    (tag) => {
      const messages = hullMessages((deck) => withoutTag(deck, tag));
      // Without a bridge there is nothing to place at the bow; the tag rule alone reports it.
      expect(messages).toEqual([`${AT}.compartments: no compartment tagged "${tag}"`]);
    },
  );

  it("requires quarters or a cabin, and takes a cabin in place of quarters", () => {
    expect(hullMessages((deck) => withoutTag(deck, "quarters"))).toEqual([
      `${AT}.compartments: no compartment tagged "quarters" or "cabin"`,
    ]);
    expect(
      hullMessages((deck) => {
        withoutTag(deck, "quarters");
        const quarters = deck.compartments.find((c) => c.key === "quarters");
        if (quarters !== undefined) quarters.tags = ["cabin"];
      }),
    ).toEqual([]);
  });

  it("requires exactly one pilot station", () => {
    const messages = hullMessages((deck) => {
      // Footprints are L3's other checks; the contract only counts stations.
      deck.machines.push({ ...placed("helm_2", "machine.helm", 2), origin: { x: 2, y: 2 } });
    });
    expect(messages).toEqual([`${AT}.machines: needs exactly one pilotStation machine, found 2`]);
  });

  it("requires the pilot station's standby position, apart from its seat (§handover)", () => {
    const helmWith = (...positions: Position[]) => ({
      ...MACHINES,
      "machine.helm": tagged("pilotStation", positions),
    });
    const expected = [
      `${AT}.machines: pilot station "helm_1" (machine.helm) has no standby position: a "use" position apart from its "operate" seat`,
    ];
    expect(hullMessages(undefined, helmWith(position("seat", ["operate", "repair"])))).toEqual(
      expected,
    );
    // A seat that is also a `use` position is no standby: the oncoming would wait in the seat.
    expect(hullMessages(undefined, helmWith(position("seat", ["operate", "use"])))).toEqual(
      expected,
    );
  });

  it("requires exactly one nav station", () => {
    const messages = hullMessages((deck) => {
      deck.machines = deck.machines.filter((m) => m.key !== "nav_1");
    });
    expect(messages).toEqual([`${AT}.machines: needs exactly one navStation machine, found 0`]);
  });

  it.each([
    ["engine", "engine_1"],
    ["messTable", "table_1"],
    ["stove", "stove_1"],
  ])("requires at least one %s", (tag, key) => {
    const messages = hullMessages((deck) => {
      deck.machines = deck.machines.filter((m) => m.key !== key);
    });
    expect(messages).toEqual([`${AT}.machines: needs at least one ${tag} machine, found none`]);
  });

  it("requires a cargoStowage zone", () => {
    const messages = hullMessages((deck) => {
      deck.zones = deck.zones.filter((z) => z.key !== "stow");
    });
    expect(messages).toEqual([`${AT}.zones: no zone tagged "cargoStowage"`]);
  });

  it.each(["crew", "passenger"])("requires a %s spawn point", (tag) => {
    const messages = hullMessages((deck) => {
      deck.spawnPoints = deck.spawnPoints.filter((s) => !s.tags.includes(tag));
    });
    expect(messages).toEqual([`${AT}.spawnPoints: no spawn point tagged "${tag}"`]);
  });

  describe("the galley loop (§what-a-deck-must-offer)", () => {
    it.each(["pantry", "serving", "cleaningLocker"])("requires a %s zone", (tag) => {
      const messages = hullMessages((deck) => {
        deck.zones = deck.zones.filter((z) => !z.tags.includes(tag));
      });
      expect(messages).toContain(`${AT}.zones: no zone tagged "${tag}"`);
    });

    it("requires a serving tile beside the stove's use position", () => {
      const messages = hullMessages((deck) => {
        deck.zones = deck.zones.map((z) =>
          z.key === "serving" ? { ...z, tiles: [{ x: 6, y: 2 }] } : z,
        );
      });
      expect(messages).toEqual([
        `${AT}.zones: no "serving" tile is beside a stove's use position: (2,1)`,
      ]);
    });

    it("does not take the stove's own use tile as beside it", () => {
      const messages = hullMessages((deck) => {
        deck.zones = deck.zones.map((z) =>
          z.key === "serving" ? { ...z, tiles: [{ x: 2, y: 1 }] } : z,
        );
      });
      expect(messages).toHaveLength(1);
    });

    it("requires the mess tables to seat four", () => {
      const messages = hullMessages(undefined, {
        ...MACHINES,
        "machine.table": tagged("messTable", TABLE_SEATS.slice(0, 3)),
      });
      expect(messages).toEqual([
        `${AT}.machines: the mess tables seat 3; at least 4 use positions are needed`,
      ]);
    });

    it("counts seats across tables", () => {
      const messages = hullMessages(
        (deck) => {
          deck.machines.push(placed("table_2", "machine.table", 7));
        },
        { ...MACHINES, "machine.table": tagged("messTable", TABLE_SEATS.slice(0, 2)) },
      );
      expect(messages).toEqual([]);
    });
  });

  describe("lockers", () => {
    const locker = (key: string, machineKey?: string) => ({
      key,
      name: key,
      tags: ["locker"],
      tiles: [{ x: 4, y: 1 }],
      ...(machineKey === undefined ? {} : { machineKey }),
    });
    const withLockers = (...lockers: ReturnType<typeof locker>[]) =>
      hullMessages((deck) => {
        deck.zones = [...deck.zones, ...lockers] as RawDeck["zones"];
      });

    it("accepts one locker per bed", () => {
      expect(withLockers(locker("locker_1", "bunk_1"), locker("locker_2", "bunk_2"))).toEqual([]);
    });

    it("rejects a locker that names no bed", () => {
      expect(withLockers(locker("locker_1"))).toEqual([
        `${AT}.zones.4.machineKey: locker "locker_1" names no bed (machineKey)`,
      ]);
    });

    it("rejects a locker serving a placement that is not a bed", () => {
      expect(withLockers(locker("locker_1", "helm_1"))).toEqual([
        `${AT}.zones.4.machineKey: locker "locker_1" serves "helm_1", which is not a bed`,
      ]);
    });

    it("does not count the infirmary's medBed as a bed", () => {
      const messages = hullMessages((deck) => {
        deck.machines = deck.machines.map((m) =>
          m.key === "bunk_2" ? { ...m, machineDefId: "machine.medbed" } : m,
        );
        deck.zones = [...deck.zones, locker("locker_1", "bunk_2")] as RawDeck["zones"];
      });
      expect(messages).toEqual([
        `${AT}.zones.4.machineKey: locker "locker_1" serves "bunk_2", which is not a bed`,
      ]);
    });

    it("rejects two lockers serving one bed", () => {
      expect(withLockers(locker("locker_1", "bunk_1"), locker("locker_2", "bunk_1"))).toEqual([
        `${AT}.zones.5.machineKey: lockers "locker_1" and "locker_2" both serve bed "bunk_1"`,
      ]);
    });
  });
});

describe("per-scenario capacity (§what-a-deck-must-offer)", () => {
  const scenarioWith = (crew: number) =>
    scenarioDefSchema.parse({
      id: "scenario.test.hull",
      name: "Hull test",
      deckId: "deck.test.hull",
      startPortId: "port.test.a",
      crew: Array.from({ length: crew }, (_, i) => `crew.test.c${i}`),
      startingMoney: 0,
      startingItems: [],
      initialFaults: [],
    });
  const SCENARIO_AT = "physical scenarios.scenario.test.hull.crew";

  it("needs a crew spawn point per crew member", () => {
    const ok: ValidationIssue[] = [];
    checkScenarioCrewSpawns(scenarioWith(1), deckWith(), ok);
    expect(ok).toEqual([]);
    const short: ValidationIssue[] = [];
    checkScenarioCrewSpawns(scenarioWith(2), deckWith(), short);
    expect(format(short)).toEqual([
      `${SCENARIO_AT}: 2 crew but "deck.test.hull" has 1 crew spawn points`,
    ]);
  });

  it("needs beds for the crew plus one", () => {
    const ok: ValidationIssue[] = [];
    checkScenarioBeds(scenarioWith(1), deckWith(), MACHINES, ok);
    expect(ok).toEqual([]);
    const short: ValidationIssue[] = [];
    checkScenarioBeds(scenarioWith(2), deckWith(), MACHINES, short);
    expect(format(short)).toEqual([
      `${SCENARIO_AT}: 2 crew need 3 beds (crew + 1) but "deck.test.hull" has 2`,
    ]);
  });

  it("does not count a medBed toward the crew's beds", () => {
    const deck = deckWith((d) => {
      d.machines = d.machines.map((m) =>
        m.key === "bunk_2" ? { ...m, machineDefId: "machine.medbed" } : m,
      );
    });
    const issues: ValidationIssue[] = [];
    checkScenarioBeds(scenarioWith(1), deck, MACHINES, issues);
    expect(format(issues)).toEqual([
      `${SCENARIO_AT}: 1 crew need 2 beds (crew + 1) but "deck.test.hull" has 1`,
    ]);
  });
});
