/**
 * Task selection. Per SD §4.3, planner code may only import from `core/types*` and `view/**`
 * (plus planner siblings) — never `systems/**` or raw world state. dependency-cruiser enforces it.
 */
import type { Planner } from "../core/types/pipeline";
import { selectIntent } from "./select";

export { compareCandidates, selectIntent } from "./select";
export { enumerateCandidates, needUrgency, taskUrgency } from "./candidates";
export type { Candidate, CandidateSet, Rejection } from "./candidates";

/** The V1 planner. */
export const defaultPlanner: Planner = selectIntent;

/**
 * Register the V1 planner. Structural registry type (not `KernelRegistry`) so the planner does
 * not import `core/registry`, which the boundary forbids. Register after `registerWork` so task
 * derivation runs before planning within phase 7.
 */
export function registerPlannerDefaults(registry: {
  registerPlanner(planner: Planner): () => void;
}): () => void {
  return registry.registerPlanner(defaultPlanner);
}
