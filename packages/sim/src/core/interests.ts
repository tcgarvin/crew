/**
 * Interests and values (slice 4, call 8): who people are off watch. Authored for the nine in
 * their crew defs; generated for anyone else at spawn (`generateInterests`), and by a keyed hash
 * for a save migrated from before they existed (`interestsFromSeed`, no rng).
 *
 * - `generateInterests(rng, stream, id)`: two likes (the first strong), a dislike with
 *   probability 0.5 (never a like), each value uniform over the integers in [-2, 2]. Drawn with
 *   `rng.keyedFloat` keyed on the actor id, so the stream does not advance: a generated person
 *   leaves every other draw of world creation where it was (the initial needs above all), and
 *   two worlds with the same seed give the same person the same tastes.
 * - `interestsFromSeed(id)`: the same shape from a hash of the actor id alone; stable per id.
 * - `interestScore(interests, tag)`: strong like 3, like 2, neutral 1, dislike 0.
 * - `stanceOn(values, topic)`: the dot product of the values and the topic's weights.
 *
 * The planner may not import this module (the planner boundary): it scores interests from
 * `self.interests` with its own copy of the 3/2/1/0 rule.
 *
 * Owner: W3 of ship life slice 4.
 */
import { hashString32 } from "./rng";
import type { Interests, Values } from "./types/actor";
import type { RngStreamName } from "./types/common";
import { INTEREST_TAGS, type InterestTag, type TopicDef } from "./types/content";
import type { ActorId } from "./types/ids";
import type { RngApi } from "./types/pipeline";

/** A person's generated character: what they like and where they stand. */
export interface Character {
  readonly interests: Interests;
  readonly values: Values;
}

/** Value axes run over the integers -2..2 (the positive end is the axis's second word). */
const VALUE_MIN = -2;
const VALUE_STEPS = 5;
const LIKES = 2;
const DISLIKE_CHANCE = 0.5;

/** A source of uniform floats in [0, 1), one per call. */
type Draw = () => number;

/** The `i`-th of `items`, `u` uniform in [0, 1). */
function choose<T>(items: readonly T[], u: number): T {
  const item = items[Math.min(items.length - 1, Math.floor(u * items.length))];
  if (item === undefined) throw new RangeError("interests: choose from an empty list");
  return item;
}

/** The character a sequence of uniform draws makes (see the module comment). */
function characterFrom(draw: Draw): Character {
  const likes: InterestTag[] = [];
  for (let i = 0; i < LIKES; i++) {
    likes.push(
      choose(
        INTEREST_TAGS.filter((tag) => !likes.includes(tag)),
        draw(),
      ),
    );
  }
  const strong = likes[0];
  if (strong === undefined) throw new RangeError("interests: no likes drawn");
  const dislikes: InterestTag[] = [];
  // Both draws are made whatever the first says, so a later axis never depends on this one.
  const disliking = draw() < DISLIKE_CHANCE;
  const dislike = choose(
    INTEREST_TAGS.filter((tag) => !likes.includes(tag)),
    draw(),
  );
  if (disliking) dislikes.push(dislike);
  const value = (): number =>
    VALUE_MIN + Math.min(VALUE_STEPS - 1, Math.floor(draw() * VALUE_STEPS));
  return {
    interests: { likes, strong, dislikes },
    values: { orderFreedom: value(), faithReason: value(), loyaltyAmbition: value() },
  };
}

/** Successive draws as a closure over a counter. */
function counted(at: (counter: number) => number): Draw {
  let counter = 0;
  return () => at(counter++);
}

/**
 * Interests and values for actor `id`, drawn on `stream` with keyed draws (the stream does not
 * advance; see the module comment).
 */
export function generateInterests(rng: RngApi, stream: RngStreamName, id: ActorId): Character {
  return characterFrom(counted((counter) => rng.keyedFloat(stream, `interests:${id}`, counter)));
}

/** MurmurHash3's 32-bit finaliser: FNV alone leaves consecutive counters' high bits alike. */
function mix32(value: number): number {
  let z = value | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** Interests and values from a keyed hash of `id`, no rng (the 9 → 10 migration). */
export function interestsFromSeed(id: ActorId): Character {
  return characterFrom(counted((counter) => mix32(hashString32(`${id}|${counter}`)) / 2 ** 32));
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
