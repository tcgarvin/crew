/**
 * Social state helpers (slice 4, call 9; D88): the empty slice, compatibility, affinity, and the
 * rivalry key. Relationships are sparse and directed (`social.relationships[from][to]`) and hold
 * memories, not a running total: what `from` feels about `to` is the pair's compatibility plus
 * the opinions of the memories `from` holds about `to`, clamped to `±affinityRange`. Memories
 * expire and stack only so far, so affinity settles where the pair's company keeps it instead of
 * climbing for as long as the game runs (D88, after RimWorld's social memories).
 *
 * The social system drops expired memories every tick, so every memory held counts.
 *
 * Owner: W2 of ship life slice 4.
 */
import type { Actor } from "./types/actor";
import type { DeepReadonly } from "./types/common";
import type { ConfigDef } from "./types/content";
import type { ActivityDefId, ActorId } from "./types/ids";
import type { RivalryKey, SocialState, WorldState } from "./types/state";

type SocialConfig = ConfigDef["social"];
type Character = DeepReadonly<Pick<Actor, "interests" | "values">>;

/** A fresh social slice: nobody knows anyone yet, no sessions, no captain's table, no talk. */
export function emptySocial(): SocialState {
  return { relationships: {}, rivalries: {}, sessions: {}, captainsTableDay: -1 };
}

const clamp = (value: number, range: number): number => Math.max(-range, Math.min(range, value));

/**
 * How well two people get on by nature (D88): an integer in ±`compatibility.range`, the same
 * both ways (the formula is on `ConfigDef.social.compatibility`).
 */
export function compatibility(
  a: Character,
  b: Character,
  config: SocialConfig["compatibility"],
): number {
  const gap =
    Math.abs(a.values.orderFreedom - b.values.orderFreedom) +
    Math.abs(a.values.faithReason - b.values.faithReason) +
    Math.abs(a.values.loyaltyAmbition - b.values.loyaltyAmbition);
  const shared = a.interests.likes.filter((tag) => b.interests.likes.includes(tag)).length;
  const clashes =
    a.interests.likes.filter((tag) => b.interests.dislikes.includes(tag)).length +
    b.interests.likes.filter((tag) => a.interests.dislikes.includes(tag)).length;
  const raw =
    config.base -
    config.perValuePoint * gap +
    config.perSharedLike * shared -
    config.perClash * clashes;
  // `+ 0` turns a rounded −0 into 0.
  return clamp(Math.round(raw), config.range) + 0;
}

/** What `from` feels about `to`: compatibility plus held memories, clamped. Both must be actors. */
export function affinityOf(
  state: DeepReadonly<Pick<WorldState, "actors" | "social">>,
  config: SocialConfig,
  from: ActorId,
  to: ActorId,
): number {
  const a = state.actors[from];
  const b = state.actors[to];
  if (a === undefined || b === undefined || from === to) {
    throw new Error(`affinityOf: ${from} → ${to} is not a pair of actors`);
  }
  let sum = compatibility(a, b, config.compatibility);
  for (const memory of state.social.relationships[from]?.[to]?.memories ?? []) {
    sum += config.memories[memory.key].opinion;
  }
  return clamp(sum, config.affinityRange);
}

/** What `from` feels about every other actor, by id. */
export function affinitiesFrom(
  state: DeepReadonly<Pick<WorldState, "actors" | "social">>,
  config: SocialConfig,
  from: ActorId,
): Record<ActorId, number> {
  const out: Record<ActorId, number> = {};
  for (const id of Object.keys(state.actors) as ActorId[]) {
    if (id !== from) out[id] = affinityOf(state, config, from, id);
  }
  return out;
}

/** `"<a>|<b>|<activityId>"` with the two ids in ascending order. */
export function rivalryKey(a: ActorId, b: ActorId, activityId: ActivityDefId): RivalryKey {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `${first}|${second}|${activityId}`;
}
