/**
 * Planner boundary: this test imports only `planner/**` and `core/types*` (dependency-cruiser's
 * `planner-boundary` rule also covers tests here) and drives `selectIntent` with a hand-built
 * `AgentView`, proving the selector needs nothing else.
 */
import { describe, expect, it } from "vitest";
import type { DeckDef } from "../core/types/content";
import type {
  ActorId,
  DeckDefId,
  ItemDefId,
  ItemId,
  MachineId,
  ProblemId,
  TaskId,
} from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, KnownItemView, ProblemView, SelfView, TaskView } from "../core/types/view";
import type { UrgencyClass } from "../core/types/work";
import { selectIntent } from "./select";
import { weighOptions } from "./weigh";

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
  hull: { class: "test_hull", sizeClass: "S", max: 100 },
  spawnPoints: [],
};

const config: PlannerConfig = {
  time: { tickRate: 20, daySeconds: 1200, watchesPerDay: 3 },
  // The planner may not import fixtures (depcruise `planner-boundary`): the galley block by hand.
  galley: {
    mealLeadDays: 0.08,
    mealGraceDays: 0.1,
    cookSeconds: 30,
    substituteAfterDays: 0.025,
    spareServings: 1,
    servingsPerCrate: 12,
    mealSpoilDays: 0.25,
    mealCallHungerAbove: 0.2,
    lowBelowDays: 0,
    restockToDays: 0,
    goodCookingAbove: 6,
    poorCookingBelow: 3,
    treatHungerAbove: 0.1,
  },
  recreation: { joinAbove: 0.25, gatherSeconds: 30, lateJoinSeconds: 20, collapseBackoffDays: 0.1 },
  social: {
    chatRadiusTiles: 2,
    chatCooldownSeconds: 45,
    templateLines: ["{a} joked about the food"],
    chatMemoryEveryDays: 1,
    chatSour: { atZero: 0, perPoint: 0 },
    compatibility: { base: 0, perValuePoint: 0, perSharedLike: 0, perClash: 0, range: 2 },
    // The planner reads affinity from the view, never the memory table: one row stands for all.
    memories: Object.fromEntries(
      [
        "chatted",
        "rubbedWrong",
        "goodTime",
        "beatMe",
        "keepsBeatingMe",
        "goodTalk",
        "argued",
        "playedForMe",
        "sharedATable",
        "heardMeOut",
        "dressedMeDown",
        "talkedItThrough",
      ].map((key) => [key, { label: key, opinion: 1, durationDays: 1, stackLimit: 1 }]),
    ) as PlannerConfig["social"]["memories"],
    affinityRange: 10,
    avoidBelow: -3,
    preferAbove: 0,
    rivalry: { streakFor: 3 },
    debate: { agreeWithin: 2, argueBeyond: 4 },
  },
  mood: { lowBelow: -0.4, highAbove: 0.4, lowWorkSpeed: 0.9, highWorkSpeed: 1.05 },
  field: {
    warningSeconds: 12,
    alertClearSeconds: 60,
    severities: {
      light: { impactsPerMinute: 2, largeShare: 0.1, lengthSeconds: 90 },
      heavy: { impactsPerMinute: 4, largeShare: 0.25, lengthSeconds: 135 },
      brutal: { impactsPerMinute: 6, largeShare: 0.4, lengthSeconds: 180 },
    },
    helmThreading: 0.4,
    unmannedRateFactor: 1.5,
    stuckRateFactor: 0.7,
    stuckDriftImpacts: 6,
    hullDamage: { small: 3, large: 8 },
    machineEffects: { none: 25, graze: 25, damage: 25, knockout: 10, fault: 15 },
    effectIntegrity: { graze: 0.2, damage: 0.5 },
    patchRecovers: 0.5,
    maxScripted: 3,
  },
  damage: { patchSeconds: 20, plateSeconds: 40, repairSecondsPerIntegrity: 30, checkSeconds: 3 },
  intercom: { reportSeconds: 3 },
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
    cleaningAgingDays: 0.25,
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
    recreationPerDay: 0,
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
      recreation: { min: 0, max: 0 },
    },
  },
};

interface StubWork {
  readonly activity?: SelfView["activity"];
  readonly onDuty?: boolean;
  readonly problems?: readonly ProblemView[];
  readonly tasks?: readonly TaskView[];
}

function stubView(hunger: number, items: KnownItemView[], work: StubWork = {}): AgentView {
  const self: SelfView = {
    id: ME,
    name: "Stub",
    roleTags: [],
    needs: { hunger, fatigue: 0, comfort: 0, social: 0, recreation: 0 },
    capacities: { movement: 1, manipulation: 1, consciousness: 1 },
    skills: {},
    traits: [],
    mood: 0,
    location: { kind: "onDeck", deckId: DECK, x: 0.5, y: 0.5 },
    tile: { x: 0, y: 0 },
    activity: work.activity ?? { kind: "idle" },
    inventory: [],
    onDuty: work.onDuty ?? true,
    watch: {
      onWatch: false,
      nextOnWatch: false,
      dayworker: true,
      helmRole: "none",
      officerOfTheWatch: false,
    },
    thoughts: [],
    interests: { likes: [], dislikes: [] },
    values: { orderFreedom: 0, faithReason: 0, loyaltyAmbition: 0 },
    affinity: {},
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
    knownProblems: () => work.problems ?? [],
    knownTasks: () => work.tasks ?? [],
    roster: () => [],
    assignedBeds: () => [],
    sessions: () => [],
    travel: () => ({ stage: "docked" }),
    activities: () => [],
    alert: () => undefined,
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

const PUMP = "m1" as MachineId;

/**
 * A machine's `maintenanceDue` (§maintenance-due) at `urgency`, and its service task two tiles
 * away.
 */
function service(urgency: UrgencyClass): { problems: ProblemView[]; tasks: TaskView[] } {
  const problem = {
    id: "p1" as ProblemId,
    kind: "maintenanceDue",
    payload: { machineId: PUMP },
    owner: "equipment",
    visibility: "public",
    dedupeKey: "maintenanceDue:m1",
    status: "open",
    createdTick: 0,
    revision: 0,
    baseUrgency: urgency,
    location: { kind: "machine", machineId: PUMP },
  } as ProblemView;
  const task = {
    id: "t1" as TaskId,
    problemId: problem.id,
    derivationKey: "maintain",
    type: "inspect",
    target: { kind: "machine", machineId: PUMP },
    createdTick: 0,
    revision: 0,
    status: "pending",
    baseUrgency: urgency,
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: [{ x: 2, y: 0 }],
    dependencyIds: [],
    progressRef: { kind: "maintenance", machineId: PUMP },
    completion: { kind: "problemResolved" },
    estimatedWorkSeconds: 10,
  } as TaskView;
  return { problems: [problem], tasks: [task] };
}

/** A game of cards begun off watch, long enough ago that the switch cooldown has passed. */
const cards: SelfView["activity"] = {
  kind: "personal",
  activity: "recreate",
  urgency: "routineObligation",
  action: { kind: "idle" },
  sinceTick: 0,
} as unknown as SelfView["activity"];

describe("maintenance and the watch (§maintenance-due)", () => {
  it("rates a service by its problem: routine, or essential once the machine is badly worn", () => {
    expect(selectIntent(stubView(0, [], service("routineObligation")), config)).toMatchObject({
      kind: "task",
      taskId: "t1",
      urgency: "routineObligation",
    });
    expect(selectIntent(stubView(0, [], service("essentialOperation")), config)).toMatchObject({
      kind: "task",
      urgency: "essentialOperation",
    });
  });

  it("lets a game run on for routine work, and ends it for a badly worn machine", () => {
    // Ending games for routine work at the bell doubled abandoned games in `crew beats` and kept
    // no machine in better repair, so only the essential service interrupts.
    const routine = stubView(0, [], { ...service("routineObligation"), activity: cards });
    expect(selectIntent(routine, config)).toEqual({ kind: "continue" });
    const pressing = stubView(0, [], { ...service("essentialOperation"), activity: cards });
    expect(selectIntent(pressing, config)).toMatchObject({ kind: "task", taskId: "t1" });
  });

  it("keeps a game off watch, where the routine service is not theirs", () => {
    const offWatch = stubView(0, [], {
      ...service("routineObligation"),
      activity: cards,
      onDuty: false,
    });
    expect(selectIntent(offWatch, config)).toEqual({ kind: "continue" });
    expect(weighOptions(offWatch, config).rejected).toContainEqual({
      ref: "task:t1",
      reason: "offDuty",
    });
  });

  it("weighs the same ranking the selector acts on", () => {
    const view = stubView(0.6, [ration], service("routineObligation"));
    const weighing = weighOptions(view, config);
    expect(weighing.intent).toEqual(selectIntent(view, config));
    // Both routine: the service (a short walk and ten seconds) is quicker than the ration.
    expect(weighing.ranked.map((c) => c.ref)).toEqual(["task:t1", "eat:i1"]);
    expect(weighing.intent).toMatchObject({ kind: "task", taskId: "t1" });
  });
});
