/**
 * The alert in the planner (D93, D94), pure over the `AgentView`:
 * - `alertCandidate`: the officer of the watch, on alert, holds the bridge (`holdBridge`,
 *   essential) instead of walking rounds;
 * - `recreationOffered`: no recreation on alert (call 4);
 * - `damageTaskAllowed`: who takes the damage tasks; never the captain or the officer of the watch
 *   for a `checkCompartment` (they hold the bridge and send scouts, call 11); the scout is the
 *   nearest available on-duty hand.
 *
 * Gate stubs: no candidate, recreation always offered, every damage task allowed.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, ProblemView, TaskView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";

const DAMAGE_TASK_TYPES: ReadonlySet<string> = new Set([
  "repairDamage",
  "patchHull",
  "plateHull",
  "checkCompartment",
]);

/** Is this one of damage response's tasks (its rules are `damageTaskAllowed`'s)? */
export function isDamageTask(task: TaskView): boolean {
  return DAMAGE_TASK_TYPES.has(task.type);
}

export function damageTaskAllowed(
  _view: AgentView,
  _config: PlannerConfig,
  _task: TaskView,
  _problem: ProblemView,
): boolean {
  return true;
}

export function alertCandidate(
  _view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  return undefined;
}

export function recreationOffered(_view: AgentView): boolean {
  return true;
}
