/**
 * Planner boundary: this test imports only `planner/**` and `core/types*` (dependency-cruiser's
 * `planner-boundary` rule also covers tests here) and drives `selectIntent` with a hand-built
 * `AgentView`, proving the selector needs nothing else.
 */
import { describe, expect, it } from "vitest";
import type { DeckDef } from "../core/types/content";
import type { ActorId, DeckDefId, ItemDefId, ItemId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, KnownItemView, SelfView } from "../core/types/view";
import { selectIntent } from "./select";

const ME = "a1" as ActorId;
const DECK = "deck.stub" as DeckDefId;

const deck: DeckDef = {
  id: DECK,
  name: "Stub",
  width: 3,
  height: 1,
  tiles: ["AAA"],
  compartments: [{ key: "a", symbol: "A", name: "A", tags: [] }],
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

const config: PlannerConfig = {
  time: { tickRate: 20, daySeconds: 1200, watchesPerDay: 3 },
  work: {
    reconsiderEveryTicks: 10,
    switchCooldownSeconds: 2,
    claimLeaseSeconds: 4,
    timeBucketSeconds: 1,
    retryBackoffSeconds: 5,
    skillGainPerDay: 0,
    workSpeedPerSkillLevel: 0.1,
  },
  urgency: {
    needEssentialAbove: 0.7,
    needSurvivalAbove: 0.9,
    heatContainmentAbove: 0.7,
    heatSurvivalAbove: 0.9,
    routineAgingDays: 0.075,
  },
  needs: {
    hungerPerDay: 0,
    fatiguePerDayAwake: 0,
    fatiguePerDayWorking: 0,
    fatigueRecoveryPerDayAsleep: 0,
    comfortPerDay: 0,
    comfortRecoveryPerDayResting: 0,
    socialPerDay: 0,
    socialRecoveryPerDayChatting: 0,
    seekThreshold: 0.5,
    mealDays: 10 / 1200,
    sleepDays: 0.05,
    wakeBelow: 0.1,
    bedtimeAbove: 0.3,
    initialRange: {
      hunger: { min: 0, max: 0 },
      fatigue: { min: 0, max: 0 },
      comfort: { min: 0, max: 0 },
      social: { min: 0, max: 0 },
    },
  },
};

function stubView(hunger: number, items: KnownItemView[]): AgentView {
  const self: SelfView = {
    id: ME,
    name: "Stub",
    roleTags: [],
    needs: { hunger, fatigue: 0, comfort: 0, social: 0 },
    capacities: { movement: 1, manipulation: 1, consciousness: 1 },
    skills: {},
    traits: [],
    mood: 0,
    location: { kind: "onDeck", deckId: DECK, x: 0.5, y: 0.5 },
    tile: { x: 0, y: 0 },
    activity: { kind: "idle" },
    inventory: [],
    onDuty: true,
    watch: {
      onWatch: false,
      nextOnWatch: false,
      dayworker: true,
      helmRole: "none",
      officerOfTheWatch: false,
    },
    thoughts: [],
    lastPlannedTick: 0,
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
      machines: () => [],
      amenities: () => [],
    },
    fact: () => undefined,
    facts: () => [],
    knownProblems: () => [],
    knownTasks: () => [],
    roster: () => [],
    assignedBeds: () => [],
    knownItems: () => items,
    estimateTravelTicks: (to) => Math.abs(to.x) * 10,
  };
}

const ration: KnownItemView = {
  itemId: "i1" as ItemId,
  defId: "item.stub.ration" as ItemDefId,
  name: "Ration",
  tags: ["food"],
  toolKinds: [],
  location: { kind: "onDeck", deckId: DECK, x: 2.5, y: 0.5 },
  tile: { x: 2, y: 0 },
  absent: false,
  observedTick: 90,
};

describe("planner boundary", () => {
  it("selects from an AgentView alone and is pure", () => {
    expect(selectIntent(stubView(0.1, [ration]), config)).toEqual({ kind: "idle" });
    const view = stubView(0.6, [ration]);
    const first = selectIntent(view, config);
    expect(first).toMatchObject({
      kind: "personal",
      activity: "eat",
      itemId: "i1",
      urgency: "routineObligation",
    });
    expect(selectIntent(view, config)).toEqual(first);
    expect(selectIntent(stubView(0.95, [ration]), config)).toMatchObject({
      urgency: "immediateSurvival",
    });
    expect(selectIntent(stubView(0.6, [{ ...ration, absent: true }]), config)).toEqual({
      kind: "idle",
    });
  });
});
