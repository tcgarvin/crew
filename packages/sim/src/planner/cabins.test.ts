/**
 * The summons candidate (slice 4, call 15) over a hand-built `AgentView` (dependency-cruiser's
 * `planner-boundary` rule covers tests here too). One row: a corridor and the captain's cabin
 * with a desk at its far end.
 *
 *   x 0123456789
 *   0 CCCCCKKKKK    d = desk (9,0), its seat (8,0); cabin K is compartment "c2"
 */
import { describe, expect, it } from "vitest";
import type { TileCoord } from "../core/types/common";
import type { DeckDef } from "../core/types/content";
import type { ActorId, CompartmentId, DeckDefId, MachineDefId, MachineId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, MachinePlacementView, RosterEntry, SelfView } from "../core/types/view";
import { summonsCandidate } from "./cabins";

const ME = "a1" as ActorId;
const CAPTAIN = "a2" as ActorId;
const DECK = "deck.stub" as DeckDefId;
const CABIN = "c2" as CompartmentId;
const CORRIDOR = "c1" as CompartmentId;

const deck: DeckDef = {
  id: DECK,
  name: "Stub",
  width: 10,
  height: 1,
  tiles: ["CCCCCKKKKK"],
  compartments: [
    { key: "corridor", symbol: "C", name: "Corridor", tags: ["corridor"] },
    {
      key: "captainsCabin",
      symbol: "K",
      name: "Captain's Cabin",
      tags: ["cabin", "captainsCabin"],
    },
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
  hull: { class: "test_hull", sizeClass: "S" },
  spawnPoints: [],
};

const desk: MachinePlacementView = {
  machineId: "m1" as MachineId,
  defId: "machine.stub.desk" as MachineDefId,
  tags: ["desk"],
  footprint: [{ x: 9, y: 0 }],
  interactionTiles: [{ tile: { x: 8, y: 0 }, purposes: ["use"] }],
};

const config = { time: { tickRate: 20, daySeconds: 1200, watchesPerDay: 3 } } as PlannerConfig;

const rosterEntry = (actorId: ActorId): RosterEntry => ({
  actorId,
  name: actorId,
  roleTags: [],
  skills: {},
});

interface Stub {
  readonly summons?: SelfView["summons"];
  readonly roster?: readonly ActorId[];
  readonly machines?: readonly MachinePlacementView[];
  readonly backoff?: Record<string, number>;
  readonly reachable?: boolean;
  readonly helmRole?: SelfView["watch"]["helmRole"];
}

function stubView(stub: Stub): AgentView {
  const at: TileCoord = { x: 0, y: 0 };
  const machines = stub.machines ?? [desk];
  const self: SelfView = {
    id: ME,
    name: "Stub",
    roleTags: ["deckhand"],
    needs: { hunger: 0, fatigue: 0, comfort: 0, social: 0, recreation: 0 },
    capacities: { movement: 1, manipulation: 1, consciousness: 1 },
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
      helmRole: stub.helmRole ?? "none",
      officerOfTheWatch: false,
    },
    thoughts: [],
    interests: { likes: [], dislikes: [] },
    values: { orderFreedom: 0, faithReason: 0, loyaltyAmbition: 0 },
    affinity: {},
    lastPlannedTick: 0,
    ...(stub.summons === undefined ? {} : { summons: stub.summons }),
    ...(stub.backoff === undefined ? {} : { backoff: stub.backoff }),
  };
  return {
    tick: 100,
    self,
    schematic: {
      deck,
      isFloor: (tile) => tile.y === 0 && tile.x >= 0 && tile.x < 10,
      compartmentAt: (tile) => (tile.x >= 5 ? CABIN : CORRIDOR),
      isWall: () => false,
      doors: () => [],
      machines: () => machines,
      amenities: (tag) => machines.filter((m) => m.tags.includes(tag)),
    },
    fact: () => undefined,
    facts: () => [],
    knownProblems: () => [],
    knownTasks: () => [],
    roster: () => (stub.roster ?? [ME, CAPTAIN]).map(rosterEntry),
    assignedBeds: () => [],
    sessions: () => [],
    travel: () => ({ stage: "docked" }),
    activities: () => [],
    knownItems: () => [],
    estimateTravelTicks: (to, from) =>
      stub.reachable === false ? null : Math.abs(to.x - (from ?? at).x) * 10,
  };
}

const SUMMONED = { withActorId: CAPTAIN, compartmentId: CABIN, captain: false } as const;

describe("summonsCandidate (slice 4, call 15)", () => {
  it("offers nothing without a summons", () => {
    expect(summonsCandidate(stubView({}), config)).toBeUndefined();
  });

  it("answers a summons at essential class, estimated by the walk to the desk's seat", () => {
    expect(summonsCandidate(stubView({ summons: SUMMONED }), config)).toEqual({
      ref: "privateTalk",
      urgency: "essentialOperation",
      estimateTicks: 80,
      skill: 0,
      ageTick: 100,
      stableId: "privateTalk",
      choice: { kind: "personal", activity: "privateTalk", targetId: CAPTAIN },
    });
  });

  it("the caller answers their own: the summons names the one called in", () => {
    const caller = { withActorId: CAPTAIN, compartmentId: CABIN, captain: true } as const;
    expect(summonsCandidate(stubView({ summons: caller }), config)).toMatchObject({
      urgency: "essentialOperation",
      choice: { activity: "privateTalk", targetId: CAPTAIN },
    });
  });

  it("walks to the cabin's first floor tile when it has no desk", () => {
    const view = stubView({ summons: SUMMONED, machines: [] });
    expect(summonsCandidate(view, config)).toMatchObject({ estimateTicks: 50 });
  });

  it("is rejected notAboard when the other party is not on the roster", () => {
    const view = stubView({ summons: SUMMONED, roster: [ME] });
    expect(summonsCandidate(view, config)).toEqual({ ref: "privateTalk", reason: "notAboard" });
  });

  it("backs off after a failed walk, and is rejected when the cabin cannot be reached", () => {
    const backingOff = stubView({ summons: SUMMONED, backoff: { privateTalk: 1_000 } });
    expect(summonsCandidate(backingOff, config)).toEqual({ ref: "privateTalk", reason: "backoff" });
    const walledOff = stubView({ summons: SUMMONED, reachable: false });
    expect(summonsCandidate(walledOff, config)).toEqual({
      ref: "privateTalk",
      reason: "unreachableTarget",
    });
  });

  it("is rejected atTheHelm for the helm's stander and oncoming, not for a relief (D77)", () => {
    for (const helmRole of ["stander", "oncoming"] as const) {
      expect(summonsCandidate(stubView({ summons: SUMMONED, helmRole }), config)).toEqual({
        ref: "privateTalk",
        reason: "atTheHelm",
      });
    }
    const relief = stubView({ summons: SUMMONED, helmRole: "relief" });
    expect(summonsCandidate(relief, config)).toMatchObject({ urgency: "essentialOperation" });
  });
});
