/**
 * The planner's helm rule (D77): who may claim the helm's posts and the course plot, and gangway
 * watch in port. The sim decides who stands the helm (`SelfView.watch.helmRole`); this file only
 * reads it.
 *
 * Owner: W1 of ship life slice 2. Gate B stubs keep today's behaviour: anyone may claim a helm
 * task or the plot (subject to the usual off-duty and `deferTo` rules), and nobody stands gangway
 * watch.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, TaskView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";

/** Is `task` one whose eligibility this file decides (`staffStation`, `plotCourse`)? */
export function isHelmTask(task: TaskView): boolean {
  return task.type === "staffStation" || task.type === "plotCourse";
}

/**
 * May this actor take the helm task (W1: the `watch` post for `stander` and `oncoming`, the
 * `relief` post for `relief`; `plotCourse` for anyone meeting its skills)? Stub: yes.
 */
export function helmTaskAllowed(_view: AgentView, _task: TaskView): boolean {
  return true;
}

/**
 * Is the helm task exempt from the off-duty rejection and from `deferTo` (W1: yes, so the oncoming
 * claims before the bell and a junior stands under the captain's eye)? Stub: no.
 */
export function helmTaskExempt(_view: AgentView, _task: TaskView): boolean {
  return false;
}

/** Gangway watch while docked, for the section's stander (routine class). Stub: none (W1). */
export function gangwayCandidate(
  _view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  return undefined;
}
