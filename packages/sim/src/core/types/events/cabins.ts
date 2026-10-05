/** Cabin events (slice 4): a word in the captain's cabin, called, held or missed. */
import type { ActorId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface CabinsEventPayloads {
  /** `captainId` asked `actorId` for a word in their cabin (`privateTalk`). */
  privateTalkCalled: { readonly captainId: ActorId; readonly actorId: ActorId };
  /** The talk was held, in `tone`. */
  privateTalkHeld: {
    readonly captainId: ActorId;
    readonly actorId: ActorId;
    readonly tone: "warm" | "stern";
  };
  /** Not both in the cabin by `cabins.privateTalkWaitSeconds`: the talk lapsed. */
  privateTalkMissed: { readonly captainId: ActorId; readonly actorId: ActorId };
}

export const CABINS_EVENT_SIGNIFICANCE = {
  privateTalkCalled: "notable",
  // The narrator sees the result at its next call; not hooked.
  privateTalkHeld: "narrative",
  privateTalkMissed: "notable",
} as const satisfies SignificanceCatalog<CabinsEventPayloads>;
