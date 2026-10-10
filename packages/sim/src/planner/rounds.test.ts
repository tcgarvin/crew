/**
 * The on-duty idle candidate (§gangway-watch-and-rounds) over a hand-built `AgentView`
 * (dependency-cruiser's `planner-boundary` rule covers tests here too). The deck is one row:
 * engineering, the hold, the mess and the bridge, with a pump in engineering and the captain's
 * chair on the bridge.
 *
 *   x 0123456789
 *   0 EEEHHMMBBB    p = pump (1,0), repair from (2,0); c = chair (9,0), its seat (8,0)
 */
import { describe, expect, it } from "vitest";
import type { TileCoord } from "../core/types/common";
import type { DeckDef, RoleTag } from "../core/types/content";
import type { ActorId, DeckDefId, MachineDefId, MachineId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, MachinePlacementView, SelfView } from "../core/types/view";
import { dutyIdleCandidate } from "./rounds";

const ME = "a1" as ActorId;
const DECK = "deck.stub" as DeckDefId;

const deck: DeckDef = {
  id: DECK,
  name: "Stub",
  width: 10,
  height: 1,
  tiles: ["EEEHHMMBBB"],
  compartments: [
    { key: "eng", symbol: "E", name: "Engineering", tags: ["engineering"] },
    { key: "hold", symbol: "H", name: "Hold", tags: ["cargoHold"] },
    { key: "mess", symbol: "M", name: "Mess", tags: ["mess"] },
    { key: "bridge", symbol: "B", name: "Bridge", tags: ["bridge"] },
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

const pump: MachinePlacementView = {
  machineId: "m1" as MachineId,
  defId: "machine.stub.pump" as MachineDefId,
  tags: ["cooling"],
  footprint: [{ x: 1, y: 0 }],
  interactionTiles: [{ tile: { x: 2, y: 0 }, purposes: ["repair"] }],
};

const chair: MachinePlacementView = {
  machineId: "m2" as MachineId,
  defId: "machine.stub.chair" as MachineDefId,
  tags: ["chair"],
  footprint: [{ x: 9, y: 0 }],
  interactionTiles: [{ tile: { x: 8, y: 0 }, purposes: ["use"] }],
};

const config = { time: { tickRate: 20, daySeconds: 1200, watchesPerDay: 3 } } as PlannerConfig;

interface Stub {
  readonly roles?: readonly RoleTag[];
  readonly officer?: boolean;
  readonly onDuty?: boolean;
  readonly at?: TileCoord;
  readonly backoff?: Record<string, number>;
  readonly machines?: readonly MachinePlacementView[];
  readonly onDock?: boolean;
}

function stubView(stub: Stub): AgentView {
  const at = stub.at ?? { x: 4, y: 0 };
  const machines = stub.machines ?? [pump, chair];
  const self: SelfView = {
    id: ME,
    name: "Stub",
    roleTags: stub.roles ?? ["captain"],
    needs: { hunger: 0, fatigue: 0, comfort: 0, social: 0, recreation: 0 },
    capacities: { movement: 1, manipulation: 1, consciousness: 1 },
    skills: {},
    traits: [],
    mood: 0,
    location: { kind: "onDeck", deckId: DECK, x: at.x + 0.5, y: at.y + 0.5 },
    tile: at,
    activity: { kind: "idle" },
    inventory: [],
    onDuty: stub.onDuty ?? true,
    watch: {
      section: "red",
      onWatch: stub.onDuty ?? true,
      nextOnWatch: false,
      dayworker: false,
      helmRole: "none",
      officerOfTheWatch: stub.officer ?? false,
    },
    thoughts: [],
    interests: { likes: [], dislikes: [] },
    values: { orderFreedom: 0, faithReason: 0, loyaltyAmbition: 0 },
    affinity: {},
    lastPlannedTick: 0,
    ...(stub.backoff === undefined ? {} : { backoff: stub.backoff }),
    ...(stub.onDock === true ? { onDock: true as const } : {}),
  };
  return {
    tick: 100,
    self,
    schematic: {
      deck,
      isFloor: () => true,
      compartmentAt: () => undefined,
      isWall: () => false,
      doors: () => [],
      machines: () => machines,
      amenities: (tag) => machines.filter((m) => m.tags.includes(tag)),
    },
    fact: () => undefined,
    facts: () => [],
    knownProblems: () => [],
    knownTasks: () => [],
    roster: () => [],
    assignedBeds: () => [],
    sessions: () => [],
    travel: () => ({ stage: "docked" }),
    activities: () => [],
    alert: () => undefined,
    knownItems: () => [],
    estimateTravelTicks: (to, from) => Math.abs(to.x - (from ?? at).x) * 10,
  };
}

const BACKING_OFF = { rounds: 1_000 };

describe("dutyIdleCandidate (§gangway-watch-and-rounds)", () => {
  it("sends the officer of the watch on rounds, voluntary class, estimated by the walk to engineering", () => {
    expect(dutyIdleCandidate(stubView({ officer: true }), config)).toMatchObject({
      ref: "rounds",
      urgency: "voluntaryActivity",
      estimateTicks: 40,
      choice: { kind: "personal", activity: "rounds" },
    });
  });

  it("walks no round from the dock: the officer out on the quay is sent to the chair first (§gangway-watch-and-rounds)", () => {
    expect(dutyIdleCandidate(stubView({ officer: true, onDock: true }), config)).toMatchObject({
      ref: "chair",
      choice: { kind: "personal", activity: "wander", tile: { x: 8, y: 0 } },
    });
  });

  it("between rounds sends the officer to the chair's seat, and leaves them there", () => {
    const between = stubView({ officer: true, backoff: BACKING_OFF });
    expect(dutyIdleCandidate(between, config)).toMatchObject({
      ref: "chair",
      urgency: "voluntaryActivity",
      choice: { kind: "personal", activity: "wander", tile: { x: 8, y: 0 } },
    });
    const seated = stubView({ officer: true, backoff: BACKING_OFF, at: { x: 8, y: 0 } });
    expect(dutyIdleCandidate(seated, config)).toBeUndefined();
  });

  it("with no chair aboard, the officer waits at their post between rounds", () => {
    const view = stubView({ officer: true, backoff: BACKING_OFF, machines: [pump] });
    expect(dutyIdleCandidate(view, config)).toMatchObject({
      ref: "post",
      choice: { activity: "wander" },
    });
  });

  it("sends an engineer on the machine round, and to engineering between rounds", () => {
    const engineer = { roles: ["engineer"] as const };
    expect(dutyIdleCandidate(stubView(engineer), config)).toMatchObject({
      ref: "rounds",
      estimateTicks: 20,
      choice: { activity: "rounds" },
    });
    const between = stubView({ ...engineer, backoff: BACKING_OFF });
    expect(dutyIdleCandidate(between, config)).toMatchObject({
      ref: "post",
      choice: { activity: "wander" },
    });
    const there = stubView({ ...engineer, backoff: BACKING_OFF, at: { x: 0, y: 0 } });
    expect(dutyIdleCandidate(there, config)).toBeUndefined();
  });

  it("gives an engineer no round on a ship with no engineering machine to visit", () => {
    const view = stubView({ roles: ["engineer"], machines: [chair] });
    expect(dutyIdleCandidate(view, config)).toMatchObject({ ref: "post" });
  });

  it("the officer's round comes first for an officer who is also an engineer", () => {
    const view = stubView({ roles: ["engineer", "firstOfficer"], officer: true });
    expect(dutyIdleCandidate(view, config)).toMatchObject({ ref: "rounds", estimateTicks: 40 });
  });

  it("sends everyone else to their post, a captain who is not officer of the watch included", () => {
    const deckhand = stubView({ roles: ["deckhand"], at: { x: 0, y: 0 } });
    expect(dutyIdleCandidate(deckhand, config)).toMatchObject({
      ref: "post",
      choice: { activity: "wander" },
    });
    expect(dutyIdleCandidate(stubView({ roles: ["captain"] }), config)).toMatchObject({
      ref: "post",
    });
  });

  it("offers nothing off duty", () => {
    expect(dutyIdleCandidate(stubView({ officer: true, onDuty: false }), config)).toBeUndefined();
    const engineer = stubView({ roles: ["engineer"], onDuty: false });
    expect(dutyIdleCandidate(engineer, config)).toBeUndefined();
  });
});
