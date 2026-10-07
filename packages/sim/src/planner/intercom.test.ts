/**
 * The reporting reflex's candidate (D94, slice 5 call 12) over a hand-built `AgentView`
 * (dependency-cruiser's `planner-boundary` rule covers tests here too): on alert, damage seen
 * first-hand since the alert sounded and not yet public sends the actor to the nearest panel they
 * believe working, at containment class; nothing off alert, for public or reported damage, for
 * damage from before the alert, or for a bare machine status; dead and backed-off panels are
 * passed over, and with none left the reflex is rejected.
 */
import { describe, expect, it } from "vitest";
import type { FactType, KnownFact } from "../core/types/actor";
import type { TileCoord } from "../core/types/common";
import type { DeckDef } from "../core/types/content";
import type {
  ActorId,
  CompartmentId,
  DeckDefId,
  EntityId,
  MachineDefId,
  MachineId,
  ProblemId,
} from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type {
  AgentView,
  AlertView,
  MachinePlacementView,
  ProblemView,
  SelfView,
} from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import { reportCandidate } from "./intercom";

const SELF = "a1" as ActorId;
const OTHER = "a2" as ActorId;
const NEAR = "m1" as MachineId;
const FAR = "m2" as MachineId;
const STOVE = "m3" as MachineId;
const GALLEY = "c1" as CompartmentId;
const ALERT: AlertView = { sinceTick: 900, cause: "field" };

const deck = { id: "deck.stub" as DeckDefId, tiles: ["GGGGGGGGGG"] } as unknown as DeckDef;

const panel = (machineId: MachineId, x: number): MachinePlacementView => ({
  machineId,
  defId: "machine.intercom" as MachineDefId,
  tags: ["comm"],
  footprint: [{ x, y: 0 }],
  interactionTiles: [{ tile: { x, y: 1 }, purposes: ["operate"] }],
});

const machines: MachinePlacementView[] = [
  panel(FAR, 9),
  panel(NEAR, 3),
  {
    machineId: STOVE,
    defId: "machine.stove" as MachineDefId,
    tags: ["stove"],
    footprint: [{ x: 1, y: 0 }],
    interactionTiles: [{ tile: { x: 1, y: 1 }, purposes: ["use"] }],
  },
];

const config = {
  time: { tickRate: 20, daySeconds: 600, watchesPerDay: 2 },
  intercom: { reportSeconds: 3 },
} as PlannerConfig;

const stoveDamaged = (over: Partial<ProblemView> = {}): ProblemView =>
  ({
    id: "p1" as ProblemId,
    kind: "machineDamaged",
    payload: { machineId: STOVE },
    owner: "damage",
    visibility: "discovered",
    dedupeKey: `machineDamaged:${STOVE}`,
    status: "open",
    createdTick: 950,
    revision: 0,
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId: STOVE },
    ...over,
  }) as ProblemView;

function fact<T extends FactType>(
  subjectId: EntityId,
  factType: T,
  value: Extract<KnownFact, { factType: T }>["value"],
  evidence: KnownFact["evidence"] = "direct",
): KnownFact {
  return {
    subjectId,
    factType,
    value,
    observedTick: 990,
    learnedTick: 990,
    sourceId: evidence === "direct" ? SELF : OTHER,
    evidence,
    certainty: evidence === "direct" ? "confirmed" : "reported",
  } as KnownFact;
}

const sawIt = (problem: ProblemView, evidence: KnownFact["evidence"] = "direct"): KnownFact =>
  fact(problem.id, "problem", { problemId: problem.id, revision: problem.revision }, evidence);

interface ViewOptions {
  readonly alert?: AlertView | null;
  readonly problems?: readonly ProblemView[];
  readonly facts?: readonly KnownFact[];
  readonly backoff?: Record<string, number>;
  readonly tile?: TileCoord | null;
}

function view(options: ViewOptions = {}): AgentView {
  const problems = options.problems ?? [stoveDamaged()];
  const facts = options.facts ?? problems.map((p) => sawIt(p));
  const tile = options.tile === null ? undefined : (options.tile ?? { x: 1, y: 1 });
  const self = {
    id: SELF,
    ...(tile === undefined ? {} : { tile, compartmentId: GALLEY }),
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
  } as unknown as SelfView;
  return {
    tick: 1000,
    self,
    schematic: {
      deck,
      machines: () => machines,
      amenities: (tag: string) => machines.filter((m) => m.tags.some((t) => t === tag)),
    },
    fact: (subjectId: EntityId, factType: FactType) =>
      facts.find((f) => f.subjectId === subjectId && f.factType === factType),
    facts: () => facts,
    knownProblems: () => problems,
    alert: () => (options.alert === null ? undefined : (options.alert ?? ALERT)),
    estimateTravelTicks: (to: TileCoord) => 10 * Math.abs(to.x - (tile?.x ?? 0)),
  } as unknown as AgentView;
}

const asCandidate = (result: Candidate | Rejection | undefined): Candidate => {
  if (result === undefined || "reason" in result) {
    throw new Error(`expected a candidate, got ${JSON.stringify(result)}`);
  }
  return result;
};

describe("reportCandidate (D94)", () => {
  it("sends a witness to the nearest panel, at containment class", () => {
    const candidate = asCandidate(reportCandidate(view(), config));
    expect(candidate).toMatchObject({
      ref: `report:${NEAR}`,
      urgency: "containment",
      // Two tiles' walk (10 ticks each) and three seconds at the panel.
      estimateTicks: 20 + 60,
      choice: { kind: "personal", activity: "report", targetId: NEAR },
    });
  });

  it("reports a scar or a symptom the same as a damaged machine", () => {
    for (const kind of ["hullScar", "machineSymptom"] as const) {
      const problem = stoveDamaged({ kind } as Partial<ProblemView>);
      expect(asCandidate(reportCandidate(view({ problems: [problem] }), config)).ref).toBe(
        `report:${NEAR}`,
      );
    }
  });

  it("does nothing off alert", () => {
    expect(reportCandidate(view({ alert: null }), config)).toBeUndefined();
  });

  it("does not report what is already public", () => {
    const problem = stoveDamaged({ visibility: "public" });
    expect(reportCandidate(view({ problems: [problem] }), config)).toBeUndefined();
  });

  it("does not pass on what they only heard", () => {
    const problem = stoveDamaged();
    const heard = view({ problems: [problem], facts: [sawIt(problem, "report")] });
    expect(reportCandidate(heard, config)).toBeUndefined();
  });

  it("leaves damage from before the alert, and other kinds of problem, alone", () => {
    const before = stoveDamaged({ createdTick: ALERT.sinceTick - 1 });
    expect(reportCandidate(view({ problems: [before] }), config)).toBeUndefined();
    const fault = stoveDamaged({ kind: "machineFault" } as Partial<ProblemView>);
    expect(reportCandidate(view({ problems: [fault] }), config)).toBeUndefined();
  });

  it("is not set off by a dead machine alone (a status has no public marker to stop on)", () => {
    const dead = fact(STOVE, "machineStatus", { status: "failed", temperatureNorm: 0 });
    expect(reportCandidate(view({ problems: [], facts: [dead] }), config)).toBeUndefined();
  });

  it("passes over a panel seen dead or switched off, and one backing off", () => {
    const problem = stoveDamaged();
    for (const status of ["failed", "off"] as const) {
      const dead = fact(NEAR, "machineStatus", { status, temperatureNorm: 0 });
      const facts = [sawIt(problem), dead];
      expect(asCandidate(reportCandidate(view({ problems: [problem], facts }), config)).ref).toBe(
        `report:${FAR}`,
      );
    }
    const backoff = { [`report:${NEAR}`]: 1010 };
    expect(asCandidate(reportCandidate(view({ backoff }), config)).ref).toBe(`report:${FAR}`);
  });

  it("is rejected with no working panel left, and off the deck", () => {
    const backoff = { [`report:${NEAR}`]: 1010, [`report:${FAR}`]: 1010 };
    expect(reportCandidate(view({ backoff }), config)).toEqual({
      ref: "report",
      reason: "noWorkingPanel",
    });
    expect(reportCandidate(view({ tile: null }), config)).toEqual({
      ref: "report",
      reason: "offDeck",
    });
  });
});
