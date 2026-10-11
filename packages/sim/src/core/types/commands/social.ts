/**
 * Social commands (§memory-levers, §thought-and-reveal-levers, D106): the narrator's say in who
 * feels what about whom, through the social system's own memories and the thoughts' `addThought`.
 * Handlers: `systems/social/levers.ts`.
 */
import type { NarratorMemoryKey, ThoughtKey } from "../content";
import type { ActorId } from "../ids";

export interface SocialCommandPayloads {
  /**
   * D106, narrator and scenario: `fromActorId` remembers `key` about `toActorId` (`addMemory`'s
   * stacking and expiry), or, `lasting`, for good. Planting any narrator memory between the pair
   * (in that direction) first clears a lasting one there. Both are living people aboard (crew or
   * passengers), never the same person.
   */
  plantMemory: {
    readonly fromActorId: ActorId;
    readonly toActorId: ActorId;
    readonly key: NarratorMemoryKey;
    readonly lasting: boolean;
  };
  /**
   * D106: a falling-out between `aId` and `bId` over `over` (a person or a thing, at most
   * `FALL_OUT_OVER_MAX` characters): `wrongedOverSomeone` planted both ways and the debate's own
   * argument (the `argued` thought and memory both ways, an `argument` event). Not violent.
   */
  fallOut: { readonly aId: ActorId; readonly bId: ActorId; readonly over: string };
  /**
   * D106: `actorId` has the thought `key` (its content def's value and duration), about `refId`
   * when given; a key whose label names someone needs one.
   */
  giveThought: { readonly actorId: ActorId; readonly key: ThoughtKey; readonly refId?: ActorId };
}
