/**
 * Social events (slice 4): affinity moves, rivalries, arguments, the captain's table, and the
 * interests a newcomer was given.
 */
import type { NarratorMemoryKey, ThoughtKey } from "../content";
import type { ActivityDefId, ActorId, TopicDefId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface SocialEventPayloads {
  /** What `fromActorId` feels about `toActorId` moved by `delta` to `affinity`. */
  affinityChanged: {
    readonly fromActorId: ActorId;
    readonly toActorId: ActorId;
    readonly delta: number;
    readonly affinity: number;
  };
  /** `winnerId` has beaten `loserId` `streak` times running at `activityId`. */
  rivalryStreak: {
    readonly winnerId: ActorId;
    readonly loserId: ActorId;
    readonly activityId: ActivityDefId;
    readonly streak: number;
  };
  /**
   * `aId` and `bId` argued about `topicId` at a debate (the `sessionEnded` line carries it to the
   * ticker), or §memory-levers fell out `over` someone or something (the narrator's `fallOut`,
   * whose own line it is).
   */
  argument:
    | { readonly aId: ActorId; readonly bId: ActorId; readonly topicId: TopicDefId }
    | { readonly aId: ActorId; readonly bId: ActorId; readonly over: string };
  /**
   * §memory-levers: the narrator planted `key` in what `fromActorId` remembers of `toActorId`,
   * `lasting` or not. No ticker line: a feeling is shown by a card and the crew lines, never the log.
   */
  memoryPlanted: {
    readonly fromActorId: ActorId;
    readonly toActorId: ActorId;
    readonly key: NarratorMemoryKey;
    readonly lasting: boolean;
  };
  /** §thought-and-reveal-levers: the narrator gave `actorId` the thought `key` (no ticker line). */
  thoughtGiven: { readonly actorId: ActorId; readonly key: ThoughtKey; readonly refId?: ActorId };
  /** The captain sat beside `withActorId` at the day's captain's table. */
  captainsTable: { readonly captainId: ActorId; readonly withActorId: ActorId };
  /** `actorId` spawned without authored interests and was given generated ones. */
  interestsAssigned: { readonly actorId: ActorId };
}

export const SOCIAL_EVENT_SIGNIFICANCE = {
  affinityChanged: "trace",
  rivalryStreak: "notable",
  // The digest and the quiet timer see it; not hooked.
  argument: "narrative",
  // §memory-levers: facts for the narrator's next digest; the story shows them on a card.
  memoryPlanted: "notable",
  thoughtGiven: "notable",
  captainsTable: "trace",
  interestsAssigned: "trace",
} as const satisfies SignificanceCatalog<SocialEventPayloads>;
