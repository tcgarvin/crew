/**
 * Shared `Problem` bookkeeping for the three kinds equipment owns (`machineSymptom`,
 * `machineFault`, `maintenanceDue`): raise-or-revise by `dedupeKey` (CONTRACTS "how work is
 * advertised" step 1) and resolve. Used by both `equipment.ts` (a `StepCtx`, which can `emit`
 * directly) and `recipes.ts` (a pure `RecipeCtx`, which returns event drafts for its caller to
 * emit) — so these take `state`/`tick` directly and hand back a draft instead of emitting.
 */
import { allocateId } from "../../core/ids";
import type { LocationRef, Tick } from "../../core/types/common";
import type { EventDraft } from "../../core/types/events";
import type { ProblemId } from "../../core/types/ids";
import type { WorldState } from "../../core/types/state";
import type {
  Problem,
  ProblemKind,
  ProblemPayloads,
  ProblemVisibility,
  UrgencyClass,
} from "../../core/types/work";

export interface ProblemSpec<K extends ProblemKind> {
  readonly kind: K;
  readonly payload: ProblemPayloads[K];
  readonly dedupeKey: string;
  readonly visibility: ProblemVisibility;
  readonly baseUrgency: UrgencyClass;
  readonly location: LocationRef;
}

export interface RaiseResult {
  readonly problemId: ProblemId;
  readonly event: EventDraft | undefined;
}

function findOpen(state: WorldState, dedupeKey: string): Problem | undefined {
  return Object.values(state.work.problems).find(
    (p) => p.dedupeKey === dedupeKey && p.status === "open",
  );
}

/** Create a new open problem, or bump the revision of the existing open one with the same key. */
export function raiseProblem<K extends ProblemKind>(
  state: WorldState,
  tick: Tick,
  spec: ProblemSpec<K>,
): RaiseResult {
  const existing = findOpen(state, spec.dedupeKey);
  if (existing !== undefined) {
    existing.revision += 1;
    return { problemId: existing.id, event: undefined };
  }
  const id = allocateId(state, "problem");
  const problem = {
    id,
    kind: spec.kind,
    payload: spec.payload,
    owner: "equipment",
    visibility: spec.visibility,
    dedupeKey: spec.dedupeKey,
    status: "open",
    createdTick: tick,
    revision: 0,
    baseUrgency: spec.baseUrgency,
    location: spec.location,
  } as Problem;
  state.work.problems[id] = problem;
  return {
    problemId: id,
    event: {
      type: "problemRaised",
      subjectIds: [id],
      causeIds: [],
      source: "sim",
      payload: { problemId: id, kind: spec.kind },
    },
  };
}

/** Resolve the open problem with this `dedupeKey`, if any. No-op (and no event) if none is open. */
export function resolveProblem(state: WorldState, dedupeKey: string): EventDraft | undefined {
  const problem = findOpen(state, dedupeKey);
  if (problem === undefined) return undefined;
  problem.status = "resolved";
  return {
    type: "problemResolved",
    subjectIds: [problem.id],
    causeIds: [],
    source: "sim",
    payload: { problemId: problem.id, kind: problem.kind },
  };
}
