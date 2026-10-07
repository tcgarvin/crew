/**
 * The alert in the planner (slice 5 calls 4 and 11) over a hand-built `AgentView`
 * (dependency-cruiser's `planner-boundary` rule covers tests here too): the officer of the watch
 * holds the bridge on alert, at the chair, and nobody else is sent there; no recreation on alert;
 * the captain and the officer of the watch never take a check, and the officer takes no damage
 * work at all while the alert stands; a hand defers a check to a nearer idle colleague they can
 * see, and not to one asleep, busy or out of sight.
 */
import { describe, expect, it } from "vitest";
import type { KnownFact } from "../core/types/actor";
import type { TileCoord } from "../core/types/common";
import type { DeckDef, RoleTag } from "../core/types/content";
import type {
  ActorId,
  CompartmentId,
  DeckDefId,
  MachineDefId,
  MachineId,
  ProblemId,
  TaskId,
} from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type {
  AgentView,
  AlertView,
  MachinePlacementView,
  ProblemView,
  RosterEntry,
  SelfView,
  TaskView,
} from "../core/types/view";
import { alertCandidate, damageTaskAllowed, isDamageTask, recreationOffered } from "./alert";

const SELF = "a1" as ActorId;
const MATE = "a2" as ActorId;
const CAPTAIN = "a3" as ActorId;
const HOLD = "c1" as CompartmentId;

//   x 0123456
//   0 HHHHBBB    H = hold, B = bridge; the chair (5,0) is sat at (5,1)
//   1 HHHHBBB
const deck: DeckDef = {
  id: "deck.stub" as DeckDefId,
  name: "Stub",
  width: 7,
  height: 2,
  tiles: ["HHHHBBB", "HHHHBBB"],
  compartments: [
    { key: "hold", symbol: "H", name: "Hold", tags: ["cargoHold"] },
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

const CHAIR_SEAT: TileCoord = { x: 5, y: 1 };

const machines: MachinePlacementView[] = [
  {
    machineId: "m1" as MachineId,
    defId: "machine.chair" as MachineDefId,
    tags: ["chair"],
    footprint: [{ x: 5, y: 0 }],
    interactionTiles: [{ tile: CHAIR_SEAT, purposes: ["use"] }],
  },
];

const config = {
  time: { tickRate: 20, daySeconds: 600, watchesPerDay: 2 },
  work: { reconsiderEveryTicks: 10 },
} as PlannerConfig;

const ALERT: AlertView = { sinceTick: 900, cause: "field" };

interface ViewOptions {
  readonly alert?: AlertView;
  readonly officer?: boolean;
  readonly roles?: readonly RoleTag[];
  readonly tile?: TileCoord;
  readonly backoff?: Record<string, number>;
  readonly facts?: readonly KnownFact[];
}

const roster: RosterEntry[] = [
  { actorId: SELF, name: "Self", roleTags: ["deckhand"], skills: {} },
  { actorId: MATE, name: "Mate", roleTags: ["deckhand"], skills: {} },
  { actorId: CAPTAIN, name: "Captain", roleTags: ["captain"], skills: {} },
];

const manhattan = (a: TileCoord, b: TileCoord): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function view(options: ViewOptions = {}): AgentView {
  const here = options.tile ?? { x: 0, y: 0 };
  const self = {
    id: SELF,
    roleTags: options.roles ?? ["deckhand"],
    onDuty: true,
    tile: here,
    watch: { officerOfTheWatch: options.officer ?? false },
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
  } as unknown as SelfView;
  const facts = options.facts ?? [];
  return {
    tick: 1000,
    self,
    schematic: {
      deck,
      isFloor: (t: TileCoord) => deck.tiles[t.y]?.[t.x] !== undefined,
      machines: () => machines,
      amenities: (tag: string) => machines.filter((m) => m.tags.some((t) => t === tag)),
    },
    roster: () => roster,
    fact: (subjectId: string, factType: string) =>
      facts.find((f) => f.subjectId === subjectId && f.factType === factType),
    alert: () => options.alert,
    estimateTravelTicks: (to: TileCoord, from?: TileCoord) => manhattan(from ?? here, to),
  } as unknown as AgentView;
}

function task(type: TaskView["type"], door: TileCoord = { x: 3, y: 1 }): TaskView {
  return {
    id: "t1" as TaskId,
    problemId: "p1" as ProblemId,
    derivationKey: type,
    type,
    target: { kind: "compartment", compartmentId: HOLD },
    createdTick: 900,
    revision: 1,
    status: "pending",
    baseUrgency: "essentialOperation",
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: [door],
    dependencyIds: [],
    progressRef: { kind: "check", compartmentId: HOLD },
    completion: { kind: "problemResolved" },
    estimatedWorkSeconds: 3,
  };
}

const problem = {
  id: "p1" as ProblemId,
  kind: "compartmentToCheck",
  payload: { compartmentId: HOLD },
} as unknown as ProblemView;

/** A fresh sighting of `actorId` at `tile`. */
function seen(
  actorId: ActorId,
  tile: TileCoord,
  status: Partial<{ asleep: boolean; idle: boolean; observedTick: number }> = {},
): KnownFact {
  return {
    subjectId: actorId,
    factType: "actorStatus",
    value: {
      availability: "available",
      asleep: status.asleep ?? false,
      tile,
      idle: status.idle ?? true,
    },
    observedTick: status.observedTick ?? 995,
    learnedTick: status.observedTick ?? 995,
    sourceId: SELF,
    evidence: "direct",
    certainty: "confirmed",
  };
}

describe("the bridge hold (call 4)", () => {
  it("the officer of the watch, on alert, holds the bridge at the chair, essential", () => {
    const candidate = alertCandidate(view({ alert: ALERT, officer: true }), config);
    expect(candidate).toMatchObject({
      ref: "holdBridge",
      urgency: "essentialOperation",
      estimateTicks: manhattan({ x: 0, y: 0 }, CHAIR_SEAT),
      choice: { kind: "personal", activity: "holdBridge" },
    });
  });

  it("no hold off alert, nor for anyone but the officer of the watch", () => {
    expect(alertCandidate(view({ officer: true }), config)).toBeUndefined();
    expect(alertCandidate(view({ alert: ALERT }), config)).toBeUndefined();
  });

  it("a hold that failed backs off", () => {
    const backoff = { holdBridge: 2000 };
    expect(alertCandidate(view({ alert: ALERT, officer: true, backoff }), config)).toEqual({
      ref: "holdBridge",
      reason: "backoff",
    });
  });
});

describe("recreation on alert (call 4)", () => {
  it("is offered off alert and not on it", () => {
    expect(recreationOffered(view())).toBe(true);
    expect(recreationOffered(view({ alert: ALERT }))).toBe(false);
  });
});

describe("who takes damage work (call 11)", () => {
  it("knows its four task types", () => {
    expect(
      ["repairDamage", "patchHull", "plateHull", "checkCompartment", "repair"].map((type) =>
        isDamageTask(task(type as TaskView["type"])),
      ),
    ).toEqual([true, true, true, true, false]);
  });

  it("the captain and the officer of the watch never take a check", () => {
    const check = task("checkCompartment");
    expect(damageTaskAllowed(view({ roles: ["captain"] }), config, check, problem)).toBe(false);
    expect(damageTaskAllowed(view({ officer: true }), config, check, problem)).toBe(false);
    expect(damageTaskAllowed(view(), config, check, problem)).toBe(true);
  });

  it("the officer of the watch takes no damage work on alert, and repairs and patches off it", () => {
    for (const type of ["repairDamage", "patchHull", "plateHull"] as const) {
      expect(
        damageTaskAllowed(view({ officer: true, alert: ALERT }), config, task(type), problem),
      ).toBe(false);
      expect(damageTaskAllowed(view({ officer: true }), config, task(type), problem)).toBe(true);
    }
  });

  it("a hand defers a check to a nearer idle colleague in sight", () => {
    const check = task("checkCompartment", { x: 3, y: 1 });
    const nearer = view({ tile: { x: 0, y: 0 }, facts: [seen(MATE, { x: 3, y: 0 })] });
    expect(damageTaskAllowed(nearer, config, check, problem)).toBe(false);
    const farther = view({ tile: { x: 2, y: 1 }, facts: [seen(MATE, { x: 0, y: 0 })] });
    expect(damageTaskAllowed(farther, config, check, problem)).toBe(true);
  });

  it("but not to one asleep, busy, seen too long ago, or the captain", () => {
    const check = task("checkCompartment", { x: 3, y: 1 });
    const at = { x: 3, y: 0 };
    for (const fact of [
      seen(MATE, at, { asleep: true }),
      seen(MATE, at, { idle: false }),
      seen(MATE, at, { observedTick: 900 }),
      seen(CAPTAIN, at),
    ]) {
      expect(damageTaskAllowed(view({ facts: [fact] }), config, check, problem)).toBe(true);
    }
  });
});
