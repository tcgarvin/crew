/**
 * Cabin commands (slice 4). `privateTalk` is a card side effect, not a narrator lever: the
 * narrator offers it on a `surfaceDecision` side and the player's choice issues it (options run as
 * `player`). The command actor calls `actorId` in for a word in their cabin, warm or stern.
 */
import type { ActorId } from "../ids";

export interface CabinsCommandPayloads {
  privateTalk: { readonly actorId: ActorId; readonly tone: "warm" | "stern" };
}
