/**
 * The four problems damage response owns (D93, D94), raised, revised and resolved here so every
 * file of the stream agrees on their keys and shape:
 *
 * - `machineDamaged` (dedupe `machineDamaged:<machineId>`, discovered, located at the machine,
 *   essential), from `damageMachine`;
 * - `hullScar` (dedupe `hullScar:<scarId>`, discovered, located at the compartment; essential on
 *   alert, routine after), from `onImpact`;
 * - `hullDamaged` (dedupe `hullDamaged:<itemDefId>`, public, located at the port, routine), from
 *   the damage pass while docked;
 * - `compartmentToCheck` (dedupe `check:<compartmentId>`, public, located at the compartment,
 *   essential), from the damage pass on alert.
 *
 * Owner: W2 of ship life slice 5.
 */
import { allocateId } from "../../core/ids";
import type { LocationRef } from "../../core/types/common";
import type { ProblemId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type {
  Problem,
  ProblemOfKind,
  ProblemPayloads,
  ProblemVisibility,
  UrgencyClass,
} from "../../core/types/work";
import { emitSim } from "../work/events";

/** The kinds this stream owns. */
export type DamageKind = "machineDamaged" | "hullScar" | "hullDamaged" | "compartmentToCheck";

export const dedupeKeys = {
  machineDamaged: (machineId: string): string => `machineDamaged:${machineId}`,
  hullScar: (scarId: string): string => `hullScar:${scarId}`,
  hullDamaged: (itemDefId: string): string => `hullDamaged:${itemDefId}`,
  compartmentToCheck: (compartmentId: string): string => `check:${compartmentId}`,
} as const;

/** A scar's problem is essential while the alert stands and routine after (call 4). */
export function scarUrgency(ctx: Pick<StepCtx, "state">): UrgencyClass {
  return ctx.state.alert === undefined ? "routineObligation" : "essentialOperation";
}

export interface DamageProblemSpec<K extends DamageKind> {
  readonly kind: K;
  readonly payload: ProblemPayloads[K];
  readonly dedupeKey: string;
  readonly visibility: ProblemVisibility;
  readonly baseUrgency: UrgencyClass;
  readonly location: LocationRef;
}

/** Every open problem of `kind`, in id order. */
export function openOfKind<K extends DamageKind>(
  ctx: Pick<StepCtx, "state">,
  kind: K,
): ProblemOfKind<K>[] {
  return Object.values(ctx.state.work.problems).filter(
    (p): p is ProblemOfKind<K> => p.kind === kind && p.status === "open",
  );
}

/** The open problem with this dedupe key, if any. */
export function openByKey(ctx: Pick<StepCtx, "state">, dedupeKey: string): Problem | undefined {
  return Object.values(ctx.state.work.problems).find(
    (p) => p.status === "open" && p.dedupeKey === dedupeKey,
  );
}

/**
 * Raise the problem, or bump the revision of the open one with the same key (so its tasks
 * re-derive). Returns the problem's id.
 */
export function raiseOrRevise<K extends DamageKind>(
  ctx: StepCtx,
  spec: DamageProblemSpec<K>,
): ProblemId {
  const existing = openByKey(ctx, spec.dedupeKey);
  if (existing !== undefined) {
    existing.revision += 1;
    return existing.id;
  }
  const id = allocateId(ctx.state, "problem");
  ctx.state.work.problems[id] = {
    id,
    kind: spec.kind,
    payload: spec.payload,
    owner: "damage",
    visibility: spec.visibility,
    dedupeKey: spec.dedupeKey,
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: spec.baseUrgency,
    location: spec.location,
  } as Problem;
  emitSim(ctx, "problemRaised", [id], { problemId: id, kind: spec.kind });
  return id;
}

/** Resolve an open problem (its tasks complete at the next derivation pass). */
export function resolve(ctx: StepCtx, problem: Problem): void {
  if (problem.status !== "open") {
    throw new Error(`damage: problem ${problem.id} is ${problem.status}, not open`);
  }
  problem.status = "resolved";
  emitSim(ctx, "problemResolved", [problem.id], { problemId: problem.id, kind: problem.kind });
}
