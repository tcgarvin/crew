/**
 * The recreation candidate's scoring (slice 4, call 2) over a hand-built `AgentView`
 * (dependency-cruiser's `planner-boundary` rule covers tests here too): off duty above
 * `joinAbove`, on duty only past the seek threshold and voluntary (§choosing-recreation); interest
 * 3/2/1/0 with a dislike never chosen; joining needs a neutral, hosting a like; an open table +2
 * and hosting a group activity +1; join over host over solo, then the bigger table;
 * friends and enemies in a session; mood; the voyage and a blocking problem; backoff.
 */
import { describe, expect, it } from "vitest";
import type { Interests } from "../core/types/actor";
import type { TileCoord } from "../core/types/common";
import type { ActivityDef, DeckDef } from "../core/types/content";
import type {
  ActivityDefId,
  ActorId,
  CompartmentId,
  DeckDefId,
  MachineDefId,
  MachineId,
  ProblemId,
  SessionId,
} from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { TravelStage } from "../core/types/travel";
import type {
  AgentView,
  MachinePlacementView,
  ProblemView,
  SelfView,
  SessionView,
} from "../core/types/view";
import { interestScoreOf, recreationCandidate } from "./recreation";

const SELF = "a1" as ActorId;
const FRIEND = "a2" as ActorId;
const ENEMY = "a3" as ActorId;
const LOUNGE = "c1" as CompartmentId;
const TABLE = "m1" as MachineId;

const deck: DeckDef = {
  id: "deck.stub" as DeckDefId,
  name: "Stub",
  width: 6,
  height: 2,
  tiles: ["LLLLGG", "LLLLGG"],
  compartments: [
    { key: "lounge", symbol: "L", name: "Lounge", tags: ["lounge"] },
    { key: "galley", symbol: "G", name: "Galley", tags: ["galley"] },
  ],
  doors: [],
  openings: [],
  walls: [],
  machines: [],
  powerDomains: [],
  zones: [{ key: "viewport", name: "Viewport", tags: ["viewport"], tiles: [{ x: 3, y: 1 }] }],
  docking: {
    cargoRampDoorKey: "x",
    personnelRampDoorKey: "x",
    cargoTransferTiles: [],
    personnelTransferTiles: [],
  },
  hull: { class: "test_hull", sizeClass: "S", max: 100 },
  spawnPoints: [],
};

const machines: MachinePlacementView[] = [
  {
    machineId: TABLE,
    defId: "machine.table" as MachineDefId,
    tags: ["gamesTable"],
    footprint: [{ x: 1, y: 0 }],
    interactionTiles: [{ tile: { x: 1, y: 1 }, purposes: ["use"] }],
  },
  {
    machineId: "m2" as MachineId,
    defId: "machine.stove" as MachineDefId,
    tags: ["stove"],
    footprint: [{ x: 5, y: 0 }],
    interactionTiles: [{ tile: { x: 5, y: 1 }, purposes: ["use"] }],
  },
];

const def = (over: Partial<ActivityDef> & Pick<ActivityDef, "id" | "interest">): ActivityDef => ({
  label: over.id,
  waitingLabel: over.id,
  venue: [{ compartmentTag: "lounge" }],
  participants: { min: 1, max: 1 },
  durationDays: 0.1,
  restores: { recreation: 0.4 },
  outcome: "none",
  ...over,
});

const CARDS = def({
  id: "activity.cards" as ActivityDefId,
  interest: "cards",
  venue: [{ machineTag: "gamesTable" }],
  participants: { min: 2, max: 4 },
  outcome: "contest",
  solo: { label: "playing solitaire", durationDays: 0.06, restores: { recreation: 0.3 } },
});
const EXERCISE = def({ id: "activity.exercise" as ActivityDefId, interest: "exercise" });
const STARGAZING = def({
  id: "activity.stargazing" as ActivityDefId,
  interest: "stargazing",
  venue: [{ zoneTag: "viewport" }],
  transitOnly: true,
});
const DEBATE = def({
  id: "activity.debate" as ActivityDefId,
  interest: "debate",
  participants: { min: 2, max: 3 },
  outcome: "debate",
});
const VIDEO_GAME = def({
  id: "activity.video_game" as ActivityDefId,
  interest: "vids",
  participants: { min: 1, max: 2 },
  outcome: "contest",
});
const VIDS = def({
  id: "activity.vids" as ActivityDefId,
  interest: "vids",
  participants: { min: 1, max: 4 },
  outcome: "bond",
});
const BAKING = def({
  id: "activity.baking" as ActivityDefId,
  interest: "cooking",
  venue: [{ machineTag: "stove" }],
  blockedByProblems: ["mealToCook"],
});

const config = {
  time: { tickRate: 20, daySeconds: 600, watchesPerDay: 2 },
  needs: { seekThreshold: 0.5 },
  recreation: { joinAbove: 0.25, gatherSeconds: 30, lateJoinSeconds: 20, collapseBackoffDays: 0.1 },
  social: { avoidBelow: -3, preferAbove: 0 },
  mood: { lowBelow: -0.4, highAbove: 0.4 },
} as PlannerConfig;

interface ViewOptions {
  readonly interests?: Interests;
  readonly recreation?: number;
  readonly mood?: number;
  readonly onDuty?: boolean;
  readonly sessions?: readonly SessionView[];
  readonly affinity?: Record<ActorId, number>;
  readonly stage?: TravelStage;
  readonly problems?: readonly ProblemView[];
  readonly backoff?: Record<string, number>;
  readonly activities?: readonly ActivityDef[];
}

function view(options: ViewOptions = {}): AgentView {
  const self = {
    id: SELF,
    needs: { hunger: 0, fatigue: 0, comfort: 0, social: 0, recreation: options.recreation ?? 0.6 },
    mood: options.mood ?? 0,
    onDuty: options.onDuty ?? false,
    tile: { x: 0, y: 0 },
    interests: options.interests ?? { likes: ["cards"], strong: "cards", dislikes: [] },
    affinity: options.affinity ?? {},
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
  } as unknown as SelfView;
  const floor = (t: TileCoord) => deck.tiles[t.y]?.[t.x] !== undefined;
  return {
    tick: 1000,
    self,
    schematic: {
      deck,
      isFloor: floor,
      compartmentAt: (t: TileCoord) =>
        deck.tiles[t.y]?.[t.x] === "L" ? LOUNGE : ("c2" as CompartmentId),
      isWall: () => false,
      doors: () => [],
      machines: () => machines,
      amenities: (tag: string) => machines.filter((m) => m.tags.some((t) => t === tag)),
    },
    knownProblems: () => options.problems ?? [],
    knownItems: () => [],
    sessions: () => options.sessions ?? [],
    travel: () => ({ stage: options.stage ?? "docked" }),
    activities: () => options.activities ?? [CARDS, EXERCISE],
    estimateTravelTicks: (to: TileCoord) => Math.abs(to.x) + Math.abs(to.y),
  } as unknown as AgentView;
}

function session(members: readonly ActorId[], startedTick?: number): SessionView {
  return {
    id: "s1" as SessionId,
    activityId: CARDS.id,
    venue: { compartmentId: LOUNGE, machineId: TABLE },
    hostId: members[0] ?? FRIEND,
    members,
    openedTick: 990,
    ...(startedTick === undefined ? {} : { startedTick, endsAtTick: startedTick + 1200 }),
    label: "playing cards",
  };
}

function choice(result: ReturnType<typeof recreationCandidate>) {
  if (result === undefined || !("choice" in result)) return undefined;
  return result.choice.kind === "personal" ? result.choice : undefined;
}

describe("interestScoreOf", () => {
  it("is 3 for the keen one, 2 for a like, 1 neutral, 0 for a dislike", () => {
    const v = view({
      interests: { likes: ["cards", "vids"], strong: "cards", dislikes: ["music"] },
    });
    expect([
      interestScoreOf(v, "cards"),
      interestScoreOf(v, "vids"),
      interestScoreOf(v, "debate"),
      interestScoreOf(v, "music"),
    ]).toEqual([3, 2, 1, 0]);
  });
});

describe("recreationCandidate (call 2)", () => {
  it("offers nothing at or below joinAbove, nor on duty at or below the seek threshold", () => {
    expect(recreationCandidate(view({ recreation: 0.25 }), config)).toBeUndefined();
    expect(recreationCandidate(view({ onDuty: true, recreation: 0.5 }), config)).toBeUndefined();
    // Not even to join an open table: on duty the off-going watch's games are not one's own.
    const open = [session([FRIEND])];
    expect(
      recreationCandidate(view({ onDuty: true, recreation: 0.4, sessions: open }), config),
    ).toBeUndefined();
  });

  it("on duty past the seek threshold offers the same choice at voluntary class (§choosing-recreation)", () => {
    // An idle cook bakes or plays, but any routine work of the watch still comes first.
    const result = recreationCandidate(view({ onDuty: true }), config);
    expect(result).toMatchObject({ ref: "recreate:activity.cards", urgency: "voluntaryActivity" });
    expect(choice(result)).toMatchObject({ activityId: CARDS.id, role: "host" });
  });

  it("hosts a liked group game above the seek threshold, as one routine candidate", () => {
    const result = recreationCandidate(view(), config);
    expect(result).toMatchObject({ ref: "recreate:activity.cards", urgency: "routineObligation" });
    expect(choice(result)).toMatchObject({
      activity: "recreate",
      activityId: CARDS.id,
      role: "host",
    });
  });

  it("never chooses a dislike, even with an open table", () => {
    const interests: Interests = { likes: [], dislikes: ["cards", "exercise"] };
    expect(
      recreationCandidate(view({ interests, sessions: [session([FRIEND])] }), config),
    ).toBeUndefined();
  });

  it("a neutral joins an open table but does not host one; between joinAbove and seek only joins", () => {
    const neutral: Interests = { likes: [], dislikes: ["exercise"] };
    expect(recreationCandidate(view({ interests: neutral }), config)).toBeUndefined();
    const open = [session([FRIEND])];
    const joining = recreationCandidate(
      view({ interests: neutral, recreation: 0.3, sessions: open }),
      config,
    );
    expect(choice(joining)).toMatchObject({ role: "join", sessionId: "s1" });
    const liker = recreationCandidate(view({ recreation: 0.3 }), config);
    expect(liker).toBeUndefined();
  });

  it("prefers joining over hosting and over a liked solo activity", () => {
    const interests: Interests = { likes: ["cards", "exercise"], strong: "exercise", dislikes: [] };
    // Exercise 3 alone; cards 2 + 2 for the open table (+2 for an open session).
    const result = recreationCandidate(view({ interests, sessions: [session([FRIEND])] }), config);
    expect(choice(result)).toMatchObject({ activityId: CARDS.id, role: "join" });
  });

  it("a neutral makes up an open table rather than play their own strong solo (§choosing-recreation)", () => {
    const interests: Interests = { likes: ["exercise"], strong: "exercise", dislikes: [] };
    // Exercise 3 alone; neutral cards 1 + 2 for the open table: the tie goes to the join.
    const result = recreationCandidate(view({ interests, sessions: [session([FRIEND])] }), config);
    expect(choice(result)).toMatchObject({ activityId: CARDS.id, role: "join" });
  });

  it("hosts a liked debate rather than a strong-liked solo (company is +1)", () => {
    const interests: Interests = { likes: ["debate"], strong: "exercise", dislikes: [] };
    const activities = [DEBATE, EXERCISE];
    // Debate 2 + 1 for hosting a group activity ties exercise 3; host goes before solo.
    expect(choice(recreationCandidate(view({ interests, activities }), config))).toMatchObject({
      activityId: DEBATE.id,
      role: "host",
    });
  });

  it("puts on the vids, not the two-hand video game, at the one screen (§choosing-recreation)", () => {
    const interests: Interests = { likes: [], strong: "vids", dislikes: [] };
    // Same interest, same venue, same score: the bigger table wins before the id would.
    const activities = [VIDEO_GAME, VIDS];
    expect(choice(recreationCandidate(view({ interests, activities }), config))).toMatchObject({
      activityId: VIDS.id,
      role: "host",
    });
  });

  it("does not join a table with an enemy at it, nor host a second game of cards", () => {
    const affinity = { [ENEMY]: -3 } as Record<ActorId, number>;
    const result = recreationCandidate(view({ affinity, sessions: [session([ENEMY])] }), config);
    expect(choice(result)?.activityId).not.toBe(CARDS.id);
  });

  it("does not join a full table or one running past lateJoinSeconds", () => {
    const full = session([FRIEND, ENEMY, "a4" as ActorId, "a5" as ActorId], 990);
    const late = session([FRIEND], 1000 - 20 * 20 - 1);
    for (const s of [full, late]) {
      expect(choice(recreationCandidate(view({ sessions: [s] }), config))?.role).not.toBe("join");
    }
  });

  it("plays solitaire at a low mood, and otherwise hosts a liked game over a strong solo", () => {
    expect(choice(recreationCandidate(view({ mood: -0.5 }), config))).toMatchObject({
      activityId: CARDS.id,
      role: "solo",
    });
    const interests: Interests = { likes: ["exercise", "cards"], strong: "exercise", dislikes: [] };
    // §choosing-recreation: hosting cards (2 + 1) ties exercise (3) at an ordinary mood and the
    // host goes first (before the tuning the solo won here and only high spirits made a host); in
    // high spirits cards wins outright (2 + 1 + 1); low, the strong solo.
    expect(choice(recreationCandidate(view({ interests }), config))).toMatchObject({
      activityId: CARDS.id,
      role: "host",
    });
    expect(choice(recreationCandidate(view({ interests, mood: 0.5 }), config))).toMatchObject({
      activityId: CARDS.id,
      role: "host",
    });
    expect(choice(recreationCandidate(view({ interests, mood: -0.5 }), config))?.activityId).toBe(
      EXERCISE.id,
    );
  });

  it("offers stargazing in transit and not docked", () => {
    const interests: Interests = { likes: ["stargazing"], strong: "stargazing", dislikes: [] };
    const activities = [STARGAZING, EXERCISE];
    expect(choice(recreationCandidate(view({ interests, activities }), config))?.activityId).toBe(
      EXERCISE.id,
    );
    expect(
      choice(recreationCandidate(view({ interests, activities, stage: "transit" }), config))
        ?.activityId,
    ).toBe(STARGAZING.id);
  });

  it("does not offer baking while mealToCook is open", () => {
    const interests: Interests = { likes: ["cooking"], strong: "cooking", dislikes: [] };
    const activities = [BAKING, EXERCISE];
    expect(choice(recreationCandidate(view({ interests, activities }), config))?.activityId).toBe(
      BAKING.id,
    );
    const problem = {
      id: "p1" as ProblemId,
      kind: "mealToCook",
      status: "open",
    } as unknown as ProblemView;
    expect(
      choice(recreationCandidate(view({ interests, activities, problems: [problem] }), config))
        ?.activityId,
    ).toBe(EXERCISE.id);
  });

  it("skips an activity backing off, and rejects with backoff when nothing else is left", () => {
    const backoff = { "recreate:activity.cards": 5000 };
    const interests: Interests = { likes: ["cards"], strong: "cards", dislikes: ["exercise"] };
    expect(recreationCandidate(view({ interests, backoff }), config)).toEqual({
      ref: "recreate",
      reason: "backoff",
    });
  });
});
