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
import type { ProblemId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type {
  AgentView,
  KnownItemView,
  MachinePlacementView,
  ProblemView,
  RosterEntry,
  SelfView,
  TaskView,
  WoundView,
} from "../core/types/view";
import { convalesceCandidate, medicToWaitFor, medicalTaskAllowed } from "./medical";

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

const config = {
  time: { tickRate: 20, daySeconds: 1200, watchesPerDay: 3 },
  medical: { essentialSeverities: ["serious", "grave"], medicLevel: 4, waitForMedicSeconds: 90 },
} as unknown as PlannerConfig;

const wound = (
  bleeding: boolean,
  treated = false,
  severity: WoundView["severity"] = "serious",
): WoundView => ({ part: "leftLeg", severity, bleeding, treated });

const graze = (): WoundView => wound(false, false, "graze");

interface Stub {
  readonly wounds?: readonly WoundView[];
  readonly at?: TileCoord;
  readonly items?: readonly KnownItemView[];
  readonly facts?: readonly KnownFact[];
  readonly machines?: readonly MachinePlacementView[];
  readonly backoff?: Record<string, number>;
  readonly passenger?: boolean;
  readonly onDock?: boolean;
  readonly medical?: number;
  readonly roster?: readonly RosterEntry[];
  readonly tick?: number;
  readonly tasks?: readonly TaskView[];
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
    skills: stub.medical === undefined ? {} : { medical: stub.medical },
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
  const facts = stub.facts ?? [];
  return {
    tick: stub.tick ?? 100,
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
    fact: ((subjectId, factType) =>
      facts.find((f) => f.subjectId === subjectId && f.factType === factType)) as AgentView["fact"],
    facts: () => facts,
    knownProblems: () => [],
    knownTasks: () => stub.tasks ?? [],
    roster: () => stub.roster ?? [],
    assignedBeds: () => [],
    sessions: () => [],
    travel: () => ({ stage: "docked" }),
    shore: () => undefined,
    activities: () => [],
    alert: () => undefined,
    knownItems: () => stub.items ?? [kit],
    estimateTravelTicks: (to, from) => Math.abs(to.x - (from ?? at).x) * 10,
  };
}

/** Someone else last seen at `tile` (`OTHER` unless said), awake unless said. */
const seenAt = (tile: TileCoord, subjectId: ActorId = OTHER, asleep = false): KnownFact => ({
  subjectId,
  factType: "actorStatus",
  value: { availability: "available", asleep, tile },
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

  it("sends the wounded to the bedside: essential while bleeding or serious, routine for grazes", () => {
    expect(convalesceCandidate(stubView({ wounds: [wound(true)] }), config)).toEqual({
      ref: "convalesce",
      urgency: "essentialOperation",
      estimateTicks: 80,
      skill: 0,
      ageTick: 100,
      stableId: "convalesce",
      choice: { kind: "personal", activity: "convalesce", targetId: BED },
    });
    // A serious wound that has stopped bleeding still slows work and the helm.
    expect(convalesceCandidate(stubView({ wounds: [wound(false)] }), config)).toMatchObject({
      urgency: "essentialOperation",
    });
    const grave = stubView({ wounds: [wound(false, false, "grave")] });
    expect(convalesceCandidate(grave, config)).toMatchObject({ urgency: "essentialOperation" });
    expect(convalesceCandidate(stubView({ wounds: [graze()] }), config)).toMatchObject({
      urgency: "routineObligation",
    });
    // A treated serious wound beside an untreated graze: only the graze counts.
    const mixed = stubView({ wounds: [wound(false, true), graze()] });
    expect(convalesceCandidate(mixed, config)).toMatchObject({ urgency: "routineObligation" });
    const bleedingGraze = stubView({ wounds: [{ ...graze(), bleeding: true }] });
    expect(convalesceCandidate(bleedingGraze, config)).toMatchObject({
      urgency: "essentialOperation",
    });
  });

  it("is rejected bedTaken while someone else is believed at the bed, unless it is them there", () => {
    const taken = stubView({ wounds: [wound(false)], facts: [seenAt(BEDSIDE)] });
    expect(convalesceCandidate(taken, config)).toEqual({ ref: "convalesce", reason: "bedTaken" });
    const elsewhere = stubView({ wounds: [graze()], facts: [seenAt({ x: 3, y: 0 })] });
    expect(convalesceCandidate(elsewhere, config)).toMatchObject({ urgency: "routineObligation" });
    const lying = stubView({ wounds: [wound(false)], facts: [seenAt(BEDSIDE)], at: BEDSIDE });
    expect(convalesceCandidate(lying, config)).toMatchObject({ estimateTicks: 0 });
  });

  it("is rejected noMedicine when they know of no kit, and backoff after giving up", () => {
    const noKit = stubView({ wounds: [wound(false)], items: [{ ...kit, absent: true }] });
    expect(convalesceCandidate(noKit, config)).toEqual({ ref: "convalesce", reason: "noMedicine" });
    // A treatment of their wounds on the board says a kit is aboard, wherever it was stowed.
    const myTreatment = {
      id: "t1" as TaskId,
      type: "treatWounds",
      target: { kind: "actor", actorId: ME },
    } as unknown as TaskView;
    const told = stubView({ wounds: [wound(false)], items: [], tasks: [myTreatment] });
    expect(convalesceCandidate(told, config)).toMatchObject({
      ref: "convalesce",
      urgency: "essentialOperation",
    });
    expect(convalesceCandidate(told, config)).not.toHaveProperty("reason");
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

describe("medicToWaitFor (§the-medics-right)", () => {
  const MEDIC = "a3" as ActorId;
  const DECKHAND = "a4" as ActorId;
  const PATIENT = OTHER;
  const member = (actorId: ActorId, medical: number, extra: Partial<RosterEntry> = {}) =>
    ({ actorId, name: actorId, roleTags: [], skills: { medical }, ...extra }) as RosterEntry;
  const roster = [member(ME, 1), member(PATIENT, 1), member(MEDIC, 8), member(DECKHAND, 2)];
  const treat = {
    id: "t1" as TaskId,
    type: "treatWounds",
    target: { kind: "actor", actorId: PATIENT },
  } as unknown as TaskView;
  /** The wounded problem, raised at `createdTick`; bleeding when said. */
  const wounded = (createdTick: number, bleeding = false): ProblemView =>
    ({
      id: "p1" as ProblemId,
      kind: "crewWounded",
      payload: { actorId: PATIENT, untreated: 1, ...(bleeding ? { bleeding: true } : {}) },
      createdTick,
      status: "open",
    }) as unknown as ProblemView;

  it("leaves a fresh treatment to the ship's medic, wherever he is", () => {
    const view = stubView({ medical: 1, roster, tick: 100 });
    expect(medicToWaitFor(view, config, treat, wounded(90))).toBe(MEDIC);
    // Seen awake on the far side of the ship: still his.
    const seen = stubView({
      medical: 1,
      roster,
      tick: 100,
      facts: [seenAt({ x: 0, y: 0 }, MEDIC)],
    });
    expect(medicToWaitFor(seen, config, treat, wounded(90))).toBe(MEDIC);
  });

  it("stops waiting once the problem is waitForMedicSeconds old", () => {
    const view = stubView({ medical: 1, roster, tick: 100 + 90 * 20 });
    expect(medicToWaitFor(view, config, treat, wounded(100))).toBeUndefined();
    const justBefore = stubView({ medical: 1, roster, tick: 99 + 90 * 20 });
    expect(medicToWaitFor(justBefore, config, treat, wounded(100))).toBe(MEDIC);
  });

  it("never holds a bleeding patient", () => {
    const view = stubView({ medical: 1, roster, tick: 100 });
    expect(medicToWaitFor(view, config, treat, wounded(90, true))).toBeUndefined();
  });

  it("does not wait for a medic believed asleep, down or a passenger, nor for the patient", () => {
    const asleep = stubView({
      medical: 1,
      roster,
      tick: 100,
      facts: [seenAt({ x: 0, y: 0 }, MEDIC, true)],
    });
    expect(medicToWaitFor(asleep, config, treat, wounded(90))).toBeUndefined();
    for (const extra of [{ down: true as const }, { passenger: true as const }]) {
      const view = stubView({ medical: 1, roster: [member(MEDIC, 8, extra)], tick: 100 });
      expect(medicToWaitFor(view, config, treat, wounded(90))).toBeUndefined();
    }
    const hurtMedic = {
      ...treat,
      target: { kind: "actor", actorId: MEDIC },
    } as unknown as TaskView;
    const problem = {
      ...wounded(90),
      payload: { actorId: MEDIC, untreated: 1 },
    } as unknown as ProblemView;
    expect(
      medicToWaitFor(stubView({ medical: 1, roster, tick: 100 }), config, hurtMedic, problem),
    ).toBeUndefined();
  });

  it("lets the medic himself treat, and waits for nobody below medicLevel", () => {
    expect(
      medicToWaitFor(stubView({ medical: 8, roster, tick: 100 }), config, treat, wounded(90)),
    ).toBeUndefined();
    const noMedic = stubView({ medical: 1, roster: [member(DECKHAND, 3)], tick: 100 });
    expect(medicToWaitFor(noMedic, config, treat, wounded(90))).toBeUndefined();
  });
});
