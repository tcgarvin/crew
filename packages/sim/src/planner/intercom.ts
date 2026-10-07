/**
 * The reporting reflex (D94, slice 5 call 12), pure over the `AgentView`: on alert, someone who
 * has seen damage first-hand since the last impact that the crew do not all hold as a report
 * walks to the nearest panel they believe working and reports it (`report`, containment class:
 * above the work it reports). Nothing off alert.
 *
 * Gate stub: no candidate.
 *
 * Owner: W3 of ship life slice 5.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";

export function reportCandidate(
  _view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  return undefined;
}
