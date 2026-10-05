/**
 * Social state helpers (slice 4, call 9): the empty slice, reading an affinity, and the rivalry
 * key. Relationships are sparse and directed (`social.relationships[from][to]`); an absent entry
 * is 0. The rivalry key orders the two ids so one row holds both sides.
 *
 * Owner: W2 of ship life slice 4.
 */
import type { DeepReadonly } from "./types/common";
import type { ActivityDefId, ActorId } from "./types/ids";
import type { RivalryKey, SocialState } from "./types/state";

/** A fresh social slice: nobody knows anyone yet, no sessions, no captain's table, no talk. */
export function emptySocial(): SocialState {
  return { relationships: {}, rivalries: {}, sessions: {}, captainsTableDay: -1 };
}

/** What `from` feels about `to`; 0 when nothing has moved it. */
export function affinityOf(
  social: DeepReadonly<Pick<SocialState, "relationships">>,
  from: ActorId,
  to: ActorId,
): number {
  return social.relationships[from]?.[to]?.affinity ?? 0;
}

/** `"<a>|<b>|<activityId>"` with the two ids in ascending order. */
export function rivalryKey(a: ActorId, b: ActorId, activityId: ActivityDefId): RivalryKey {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `${first}|${second}|${activityId}`;
}
