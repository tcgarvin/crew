/**
 * The recreation candidate (slice 4, calls 1 and 2): one candidate per person, the best-scored
 * activity, never above routine class and offered off duty only: `routineObligation` above
 * `needs.seekThreshold`, `voluntaryActivity` above `recreation.joinAbove`, nothing below.
 *
 * Each `ActivityDef` the deck has a venue for is scored: interest (strong like 3, like 2, neutral
 * 1, dislike 0, never chosen; the 3/2/1/0 rule is `core/interests.ts` `interestScore`, which the
 * planner may not import, so it is restated here), +1 for an open session with room, +0.5 for a
 * session holding someone the actor likes (affinity above `social.preferAbove`), −∞ for one
 * holding someone at or below `social.avoidBelow`; with mood above `mood.highAbove` group
 * activities +1; with mood below `mood.lowBelow` solo only. Joining needs score ≥ 1 and
 * recreation above `joinAbove`; hosting needs score ≥ 2. Ties: join over host over solo, then
 * travel. Emits `recreate:<activityId>` with `choice.activityId`, `choice.role` and (joining)
 * `choice.sessionId`. Reads `self.interests`, `self.affinity`, `sessions()`, `travel()`, known
 * items (`ownerId` for an owned instrument), `knownProblems()` for `blockedByProblems`, and the
 * schematic for venue presence, and the defs from `activities()`.
 *
 * Owner: W1 of ship life slice 4. Gate stub: no candidate.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";

export function recreationCandidate(
  _view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  return undefined;
}
