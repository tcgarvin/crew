/**
 * Social events (slice 4): affinity moves, rivalries, arguments, the captain's table, and the
 * interests a newcomer was given.
 */
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
  /** `aId` and `bId` argued about `topicId` (the `sessionEnded` line carries it to the ticker). */
  argument: { readonly aId: ActorId; readonly bId: ActorId; readonly topicId: TopicDefId };
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
  captainsTable: "trace",
  interestsAssigned: "trace",
} as const satisfies SignificanceCatalog<SocialEventPayloads>;
