/**
 * Interests and values (slice 4, call 8): who people are off watch. Authored for the nine in
 * their crew defs; generated for anyone else at spawn (`generateInterests`, the `setup` stream),
 * and by a keyed hash for a save migrated from before they existed (`interestsFromSeed`, no rng).
 *
 * - `generateInterests(rng, stream)`: two likes (the first strong), a dislike with probability 0.5
 *   (never a like), each value uniform in [-2, 2].
 * - `interestsFromSeed(id)`: the same shape from a hash of the actor id; stable per id.
 * - `interestScore(interests, tag)`: strong like 3, like 2, neutral 1, dislike 0.
 * - `stanceOn(values, topic)`: the dot product of the values and the topic's weights.
 *
 * The planner may not import this module (the planner boundary): it scores interests from
 * `self.interests` with its own copy of the 3/2/1/0 rule.
 *
 * Owner: W3 of ship life slice 4. Gate stubs: `generateInterests` and `interestsFromSeed` return
 * no likes, no dislikes and neutral values, and draw nothing.
 */
import type { Interests, Values } from "./types/actor";
import type { RngStreamName } from "./types/common";
import type { InterestTag, TopicDef } from "./types/content";
import type { ActorId } from "./types/ids";
import type { RngApi } from "./types/pipeline";

/** A person's generated character: what they like and where they stand. */
export interface Character {
  readonly interests: Interests;
  readonly values: Values;
}

const NEUTRAL: Character = {
  interests: { likes: [], dislikes: [] },
  values: { orderFreedom: 0, faithReason: 0, loyaltyAmbition: 0 },
};

/** A fresh copy of the neutral character (state must never alias a shared object). */
function neutral(): Character {
  return {
    interests: { likes: [...NEUTRAL.interests.likes], dislikes: [...NEUTRAL.interests.dislikes] },
    values: { ...NEUTRAL.values },
  };
}

/** Interests and values drawn on `stream` (see the module comment). Gate stub: neutral. */
export function generateInterests(_rng: RngApi, _stream: RngStreamName): Character {
  return neutral();
}

/** Interests and values from a keyed hash of `id`, no rng (the 9 → 10 migration). Gate stub. */
export function interestsFromSeed(_id: ActorId): Character {
  return neutral();
}

/** Strong like 3, like 2, neutral 1, dislike 0. */
export function interestScore(
  interests: {
    readonly likes: readonly InterestTag[];
    readonly strong?: InterestTag;
    readonly dislikes: readonly InterestTag[];
  },
  tag: InterestTag,
): number {
  if (interests.dislikes.includes(tag)) return 0;
  if (interests.strong === tag) return 3;
  if (interests.likes.includes(tag)) return 2;
  return 1;
}

/** A debate stance: the dot product of `values` and the topic's weights. */
export function stanceOn(values: Readonly<Values>, topic: Pick<TopicDef, "weights">): number {
  const w = topic.weights;
  return (
    values.orderFreedom * w.orderFreedom +
    values.faithReason * w.faithReason +
    values.loyaltyAmbition * w.loyaltyAmbition
  );
}
