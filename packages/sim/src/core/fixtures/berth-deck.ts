/**
 * D74 test fixture: a small deck furnished like Freighter Mk2's sleeping quarters. Built on the
 * tiny content bundle; independent of `packages/content`.
 *
 *   x 0123456789ABCDEF
 *   0 llllllllKKFFpPpP    l = bunk lockers (0..7,0); p = passenger lockers (12,0) (14,0)
 *   1 bbbbbbbbBkFkbPbP    b = bunks bunk_1..bunk_8 (0..7,1), use tile below each (y 2)
 *   2 QQQQQQQQKKFFPPPP    B = captain's bed (8,1), locker k (9,1); FO bed (10,1), locker (11,1)
 *   3 QQQQQQQQKKFFPPPP    passenger beds (12,1) (14,1)
 *   4 CCCCCCCCCCCCCCCC    openings south out of Q (3,3), K (8,3), F (10,3), P (13,3)
 *   5 NmNNCCCCCCCCCCCC    m = medbay bed (1,5), bedside (2,5); infirmary door north of (1,5)
 *   6 NNNNCCCCCCCCCCCC    crew spawn points (4..15, 5), passenger (15, 6)
 *
 * Compartments (letters as in the map): Q bunkroom `[quarters]`, K captain's cabin `[cabin,
 * captainsCabin]`, F first officer's cabin `[cabin, officersCabin]`, P passenger cabin `[cabin,
 * passengerCabin]`, N infirmary, C corridor. The medbay bed is tagged `bed` *and* `medBed`, so
 * the rule that a `medBed` is never a berth or a sleep target is exercised, not just implied.
 *
 * Scenarios: `nine` (captain, first officer, seven in the bunkroom: one bunk spare), `eleven`
 * (nine in the bunkroom: the last one unberthed).
 */
import type { TileCoord } from "../types/common";
import type {
  ConfigDef,
  ContentBundle,
  CrewDef,
  MachineDef,
  MachinePlacementDef,
  RoleTag,
  ZoneDef,
} from "../types/content";
import type { CrewDefId, DeckDefId, ItemDefId, MachineDefId, ScenarioDefId } from "../types/ids";
import { TINY, tinyConfig, tinyContent } from "./tiny-content";

export const BERTH = {
  deck: "deck.test.berths" as DeckDefId,
  bunk: "machine.test.bunk" as MachineDefId,
  medBed: "machine.test.medbed" as MachineDefId,
  harmonica: "item.test.harmonica" as ItemDefId,
  photograph: "item.test.photograph" as ItemDefId,
  nine: "scenario.test.berths9" as ScenarioDefId,
  eleven: "scenario.test.berths11" as ScenarioDefId,
  captain: TINY.mara,
  firstOfficer: "crew.test.ines" as CrewDefId,
  cook: "crew.test.bettina" as CrewDefId,
} as const;

/** Bunkroom bunks in placement order. */
export const BUNKS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `bunk_${n}`);
export const CAPTAIN_BED = "captain_bed";
export const FO_BED = "fo_bed";
export const PASSENGER_BEDS = ["passenger_bed_1", "passenger_bed_2"];
export const MED_BED = "medbay_bed";

const bedDef: MachineDef = {
  id: BERTH.bunk,
  name: "Bunk",
  tags: ["bed"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [{ key: "berth", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 }],
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
};

const medBedDef: MachineDef = {
  ...bedDef,
  id: BERTH.medBed,
  name: "Medbay Bed",
  tags: ["bed", "medBed"],
  interactionPositions: [
    { key: "bedside", offset: { x: 1, y: 0 }, purposes: ["use"], capacity: 1 },
  ],
};

const bed = (key: string, x: number, y = 1): MachinePlacementDef => ({
  key,
  machineDefId: BERTH.bunk,
  origin: { x, y },
  rotation: 0,
});

const locker = (machineKey: string, x: number, y: number): ZoneDef => ({
  key: `${machineKey}_locker`,
  name: "Locker",
  tags: ["locker"],
  tiles: [{ x, y }],
  machineKey,
});

const berthDeckMachines: readonly MachinePlacementDef[] = [
  ...BUNKS.map((key, i) => bed(key, i)),
  bed(CAPTAIN_BED, 8),
  bed(FO_BED, 10),
  bed(PASSENGER_BEDS[0] as string, 12),
  bed(PASSENGER_BEDS[1] as string, 14),
  { key: MED_BED, machineDefId: BERTH.medBed, origin: { x: 1, y: 5 }, rotation: 0 },
];

/** The `use` tile of a bed by key: one south of a bunk, east of the medbay bed. */
export function bedUseTile(key: string): TileCoord {
  const placement = berthDeckMachines.find((m) => m.key === key);
  if (placement === undefined) throw new Error(`no bed ${key}`);
  const { x, y } = placement.origin;
  return key === MED_BED ? { x: x + 1, y } : { x, y: y + 1 };
}

function crewMember(
  base: CrewDef,
  id: CrewDefId,
  name: string,
  roleTags: RoleTag[],
  startingInventory: CrewDef["startingInventory"] = [],
): CrewDef {
  return { ...base, id, name, roleTags, skills: { cargo: 2 }, startingInventory };
}

const BUNKROOM_NAMES = [
  "Ada Kim",
  "Bo Lindqvist",
  "Cy Mbeki",
  "Dee Park",
  "Eli Soto",
  "Fen Ward",
  "Gus Hale",
  "Hana Ruiz",
];

/** The bunkroom crew after Bettina, as crew def ids (`crew.test.bunk0` …). */
export const BUNKROOM_CREW = BUNKROOM_NAMES.map((_, i) => `crew.test.bunk${i}` as CrewDefId);

export function berthContent(config: ConfigDef = tinyConfig()): ContentBundle {
  const base = tinyContent(config);
  const mara = base.crew[TINY.mara];
  if (mara === undefined) throw new Error("tiny content lost Mara");
  const crew: Record<CrewDefId, CrewDef> = {
    [BERTH.captain]: crewMember(
      mara,
      BERTH.captain,
      "Mara Voss",
      ["captain"],
      [
        { itemDefId: BERTH.photograph, count: 1 },
        { itemDefId: TINY.rations, count: 2 },
      ],
    ),
    [BERTH.firstOfficer]: crewMember(mara, BERTH.firstOfficer, "Ines Ward", ["firstOfficer"]),
    [BERTH.cook]: crewMember(
      mara,
      BERTH.cook,
      "Bettina Solheim",
      ["cook"],
      [{ itemDefId: BERTH.harmonica, count: 1 }],
    ),
  };
  BUNKROOM_NAMES.forEach((name, i) => {
    const id = BUNKROOM_CREW[i] as CrewDefId;
    crew[id] = crewMember(mara, id, name, [i % 2 === 0 ? "deckhand" : "engineer"]);
  });
  const scenario = (id: ScenarioDefId, bunkroom: number) => ({
    id,
    name: `Berths (${bunkroom + 3})`,
    deckId: BERTH.deck,
    startPortId: TINY.port,
    crew: [BERTH.captain, BERTH.firstOfficer, BERTH.cook, ...BUNKROOM_CREW.slice(0, bunkroom)],
    startingMoney: 0,
    startingItems: [],
    initialFaults: [],
  });
  return {
    ...base,
    decks: {
      [BERTH.deck]: {
        id: BERTH.deck,
        name: "Berth deck",
        width: 16,
        height: 7,
        tiles: [
          "QQQQQQQQKKFFPPPP",
          "QQQQQQQQKKFFPPPP",
          "QQQQQQQQKKFFPPPP",
          "QQQQQQQQKKFFPPPP",
          "CCCCCCCCCCCCCCCC",
          "NNNNCCCCCCCCCCCC",
          "NNNNCCCCCCCCCCCC",
        ],
        compartments: [
          { key: "bunkroom", symbol: "Q", name: "Bunkroom", tags: ["quarters"] },
          {
            key: "captainsCabin",
            symbol: "K",
            name: "Captain's Cabin",
            tags: ["cabin", "captainsCabin"],
          },
          {
            key: "officersCabin",
            symbol: "F",
            name: "First Officer's Cabin",
            tags: ["cabin", "officersCabin"],
          },
          {
            key: "passengerCabin",
            symbol: "P",
            name: "Passenger Cabin",
            tags: ["cabin", "passengerCabin"],
          },
          { key: "infirmary", symbol: "N", name: "Infirmary", tags: ["infirmary"] },
          { key: "corridor", symbol: "C", name: "Corridor", tags: ["corridor"] },
        ],
        doors: [
          {
            key: "infirmaryDoor",
            edge: { x: 1, y: 5, side: "n" },
            kind: "interior",
            manualOperationSupported: true,
            initialState: "open",
          },
        ],
        openings: [
          { x: 3, y: 3, side: "s" },
          { x: 8, y: 3, side: "s" },
          { x: 10, y: 3, side: "s" },
          { x: 13, y: 3, side: "s" },
        ],
        walls: [],
        machines: berthDeckMachines,
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [
          ...BUNKS.map((key, i) => locker(key, i, 0)),
          locker(CAPTAIN_BED, 9, 1),
          locker(FO_BED, 11, 1),
          locker(PASSENGER_BEDS[0] as string, 12, 0),
          locker(PASSENGER_BEDS[1] as string, 14, 0),
        ],
        docking: {
          cargoRampDoorKey: "infirmaryDoor",
          personnelRampDoorKey: "infirmaryDoor",
          cargoTransferTiles: [{ x: 15, y: 6 }],
          personnelTransferTiles: [{ x: 15, y: 6 }],
        },
        hull: { class: "test_hull", sizeClass: "S", max: 100 },
        spawnPoints: [
          ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((x) => ({
            key: `crew_${x}`,
            tile: { x, y: 5 },
            tags: ["crew" as const],
          })),
          { key: "passenger", tile: { x: 15, y: 6 }, tags: ["passenger"] },
        ],
      },
    },
    machines: { ...base.machines, [BERTH.bunk]: bedDef, [BERTH.medBed]: medBedDef },
    items: {
      ...base.items,
      [BERTH.harmonica]: {
        id: BERTH.harmonica,
        name: "Harmonica",
        stacking: "unique",
        maxStack: 1,
        tags: ["personal"],
        toolKinds: [],
        mass: 0.2,
      },
      [BERTH.photograph]: {
        id: BERTH.photograph,
        name: "Old Photograph",
        stacking: "unique",
        maxStack: 1,
        tags: ["personal"],
        toolKinds: [],
        mass: 0.1,
      },
    },
    crew: { ...base.crew, ...crew },
    scenarios: { [BERTH.nine]: scenario(BERTH.nine, 6), [BERTH.eleven]: scenario(BERTH.eleven, 8) },
    hash: "berth-deck-v1",
  };
}
