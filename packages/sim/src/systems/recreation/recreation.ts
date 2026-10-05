/**
 * The recreation system (slice 4, call 4), phase `needs`, every tick, registered after the needs
 * and mood systems. The lifecycle of a group session: it starts at `participants.max` members or
 * at `openedTick + gatherSeconds` with at least `min` (`sessionStarted`, `endsAtTick` from
 * `durationDays`); collapses at `gatherSeconds` with fewer (the host's step becomes `solo` with
 * the def's `solo` variant, or fails, and the host backs off hosting `recreate:<activityId>` for
 * `collapseBackoffDays`; the others' steps fail; `sessionCollapsed`); ends a contest or debate at
 * once with no result when a member leaves and fewer than `min` remain (`sessionEnded`,
 * `abandoned`); and resolves at `endsAtTick` (`resolveOutcome` from `systems/social/outcomes.ts`,
 * called exactly once, then the row is deleted; `sessionEnded`).
 *
 * Owner: W1 of ship life slice 4. Gate stub: a no-op (nobody opens a session yet).
 */
import type { System } from "../../core/types/pipeline";

export const recreationSystem: System = {
  name: "recreation",
  phase: "needs",
  run() {},
};
