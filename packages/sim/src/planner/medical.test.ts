/**
 * Medicine in the planner (§convalescing, §treatment-at-the-medbay-bed) over a hand-built
 * `AgentView` (dependency-cruiser's `planner-boundary` rule covers tests here too). One row: a
 * corridor and an infirmary with the medbay bed at its far end.
 *
 *   x 0123456789
 *   0 CCCCCIIIbM    M = medbay bed (9,0), its bedside `use` tile b (8,0)
 */
import { describe, expect, it } from "vitest";
import type { KnownFact } from "../core/types/actor";
import type { TileCoord } from "../core/types/common";
import type { DeckDef } from "../core/types/content";
import type {
  ActorId,
  CompartmentId,
  DeckDefId,
  ItemDefId,
  ItemId,
  MachineDefId,
  MachineId,
  TaskId,
} from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type {
  AgentView,
  KnownItemView,
  MachinePlacementView,
  SelfView,
  TaskView,
  WoundView,
} from "../core/types/view";
import { convalesceCandidate, medicalTaskAllowed } from "./medical";

const ME = "a1" as ActorId;
const OTHER = "a2" as ActorId;
const DECK = "deck.stub" as DeckDefId;
const BED = "m1" as MachineId;
const BEDSIDE: TileCoord = { x: 8, y: 0 };

const deck: DeckDef = {
  id: DECK,
  name: "Stub",
  width: 10,
  height: 1,
  tiles: ["CCCCCIIIII"],
  compartments: [
    { key: "corridor", symbol: "C", name: "Corridor", tags: ["corridor"] },
    { key: "infirmary", symbol: "I", name: "Infirmary", tags: ["infirmary"] },
  ],
  doors: [],
  openings: [],
  walls: [],
  machines: [],
  powerDomains: [],
  zones: [],
  docking: {
    cargoRampDoorKey: "x",
    personnelRampDoorKey: "x",
    cargoTransferTiles: [],
    personnelTransferTiles: [],
  },
  hull: { class: "test_hull", sizeClass: "S", max: 100 },
  spawnPoints: [],
};

const bed: MachinePlacementView = {
  machineId: BED,
  defId: "machine.stub.medbed" as MachineDefId,
  tags: ["medBed"],
  footprint: [{ x: 9, y: 0 }],
  interactionTiles: [{ tile: BEDSIDE, purposes: ["use"] }],
};

const kit: KnownItemView = {
  itemId: "i1" as ItemId,
  defId: "item.stub.kit" as ItemDefId,
  name: "Med Kit",
  tags: ["medical", "consumable"],
  toolKinds: [],
  location: { kind: "onDeck", deckId: DECK, x: 1.5, y: 0.5 },
  tile: { x: 1, y: 0 },
  absent: false,
  observedTick: 90,
};

const config = { time: { tickRate: 20, daySeconds: 1200, watchesPerDay: 3 } } as PlannerConfig;

const wound = (bleeding: boolean, treated = false): WoundView => ({
  part: "leftLeg",
  severity: "serious",
  bleeding,
  treated,
});

interface Stub {
  readonly wounds?: readonly WoundView[];
  readonly at?: TileCoord;
  readonly items?: readonly KnownItemView[];
  readonly facts?: readonly KnownFact[];
  readonly machines?: readonly MachinePlacementView[];
  readonly backoff?: Record<string, number>;
  readonly passenger?: boolean;
  readonly onDock?: boolean;
}

function stubView(stub: Stub): AgentView {
  const at = stub.at ?? { x: 0, y: 0 };
  const machines = stub.machines ?? [bed];
  const wounds = stub.wounds ?? [];
  const self: SelfView = {
    id: ME,
    name: "Stub",
    roleTags: ["deckhand"],
    needs: { hunger: 0, fatigue: 0, comfort: 0, social: 0, recreation: 0 },
    capacities: { movement: 1, manipulation: 1, consciousness: 1 },
    body: {
      capacities: { movement: 1, manipulation: 1, consciousness: 1 },
      wounded: wounds.length > 0,
      bleeding: wounds.some((w) => w.bleeding),
      wounds,
      stunned: false,
      availability: "available",
    },
    bio: "",
    skills: {},
    traits: [],
    mood: 0,
    location: { kind: "onDeck", deckId: DECK, x: at.x + 0.5, y: at.y + 0.5 },
    tile: at,
    activity: { kind: "idle" },
    inventory: [],
    onDuty: false,
    watch: {
      section: "red",
      onWatch: false,
      nextOnWatch: false,
      dayworker: false,
      helmRole: "none",
      officerOfTheWatch: false,
    },
    thoughts: [],
    interests: { likes: [], dislikes: [] },
    values: { orderFreedom: 0, faithReason: 0, loyaltyAmbition: 0 },
    affinity: {},
    lastPlannedTick: 0,
    ...(stub.backoff === undefined ? {} : { backoff: stub.backoff }),
    ...(stub.passenger === true ? { passenger: true as const } : {}),
    ...(stub.onDock === true ? { onDock: true as const } : {}),
  };
  return {
    tick: 100,
    self,
    schematic: {
      deck,
      isFloor: (tile) => tile.y === 0 && tile.x >= 0 && tile.x < 9,
      compartmentAt: (tile) => (tile.x >= 5 ? ("c2" as CompartmentId) : ("c1" as CompartmentId)),
      isWall: () => false,
      doors: () => [],
      machines: () => machines,
      amenities: (tag) => machines.filter((m) => m.tags.includes(tag)),
    },
    fact: () => undefined,
    facts: () => stub.facts ?? [],
    knownProblems: () => [],
    knownTasks: () => [],
    roster: () => [],
    assignedBeds: () => [],
    sessions: () => [],
    travel: () => ({ stage: "docked" }),
    activities: () => [],
    alert: () => undefined,
    knownItems: () => stub.items ?? [kit],
    estimateTravelTicks: (to, from) => Math.abs(to.x - (from ?? at).x) * 10,
  };
}

/** Someone else last seen at `tile`. */
const seenAt = (tile: TileCoord): KnownFact => ({
  subjectId: OTHER,
  factType: "actorStatus",
  value: { availability: "available", asleep: false, tile },
  observedTick: 90,
  learnedTick: 90,
  sourceId: ME,
  evidence: "direct",
  certainty: "confirmed",
});

describe("convalesceCandidate (§convalescing)", () => {
  it("offers nothing to the unhurt, or once every wound is treated", () => {
    expect(convalesceCandidate(stubView({}), config)).toBeUndefined();
    const treated = stubView({ wounds: [wound(false, true)] });
    expect(convalesceCandidate(treated, config)).toBeUndefined();
  });

  it("sends the wounded to the bedside: essential while bleeding, routine after", () => {
    expect(convalesceCandidate(stubView({ wounds: [wound(true)] }), config)).toEqual({
      ref: "convalesce",
      urgency: "essentialOperation",
      estimateTicks: 80,
      skill: 0,
      ageTick: 100,
      stableId: "convalesce",
      choice: { kind: "personal", activity: "convalesce", targetId: BED },
    });
    expect(convalesceCandidate(stubView({ wounds: [wound(false)] }), config)).toMatchObject({
      urgency: "routineObligation",
    });
  });

  it("is rejected bedTaken while someone else is believed at the bed, unless it is them there", () => {
    const taken = stubView({ wounds: [wound(false)], facts: [seenAt(BEDSIDE)] });
    expect(convalesceCandidate(taken, config)).toEqual({ ref: "convalesce", reason: "bedTaken" });
    const elsewhere = stubView({ wounds: [wound(false)], facts: [seenAt({ x: 3, y: 0 })] });
    expect(convalesceCandidate(elsewhere, config)).toMatchObject({ urgency: "routineObligation" });
    const lying = stubView({ wounds: [wound(false)], facts: [seenAt(BEDSIDE)], at: BEDSIDE });
    expect(convalesceCandidate(lying, config)).toMatchObject({ estimateTicks: 0 });
  });

  it("is rejected noMedicine when they know of no kit, and backoff after giving up", () => {
    const noKit = stubView({ wounds: [wound(false)], items: [{ ...kit, absent: true }] });
    expect(convalesceCandidate(noKit, config)).toEqual({ ref: "convalesce", reason: "noMedicine" });
    const gaveUp = stubView({ wounds: [wound(false)], backoff: { convalesce: 1_000 } });
    expect(convalesceCandidate(gaveUp, config)).toEqual({ ref: "convalesce", reason: "backoff" });
  });

  it("offers nothing to a passenger, on the dock, or on a ship with no medbay bed", () => {
    for (const stub of [{ passenger: true }, { onDock: true }, { machines: [] }]) {
      expect(convalesceCandidate(stubView({ wounds: [wound(true)], ...stub }), config)).toBe(
        undefined,
      );
    }
  });
});

describe("medicalTaskAllowed (§treatment-at-the-medbay-bed)", () => {
  const treat = (actorId: ActorId) =>
    ({
      id: "t1" as TaskId,
      type: "treatWounds",
      target: { kind: "actor", actorId },
    }) as unknown as TaskView;

  it("lets anyone treat a crewmate, and nobody their own wounds", () => {
    expect(medicalTaskAllowed(stubView({}), treat(OTHER))).toBe(true);
    expect(medicalTaskAllowed(stubView({}), treat(ME))).toBe(false);
  });
});
