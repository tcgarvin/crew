/**
 * The summons candidate (slice 4, call 15): a pending `privateTalk` (`self.summons`) makes a
 * `privateTalk` personal candidate at `essentialOperation` for both the caller and the one called
 * in: it interrupts cards, rounds and rest, not the helm (same class). Rejected `notAboard` when
 * the summons names someone not on the roster.
 *
 * Owner: W3 of ship life slice 4. Gate stub: no candidate.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";

export function summonsCandidate(
  _view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  return undefined;
}
