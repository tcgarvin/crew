/** Dirt events (§room-tiers): a room's tier changing, and a room mopped clean. */
import type { ActorId, CompartmentId, LocalKey } from "../ids";
import type { SignificanceCatalog } from "./significance";

/** The room, by instance and by `CompartmentDef.key` (the key of `WorldState.dirt.tiers`). */
export interface RoomEvent {
  readonly compartmentId: CompartmentId;
  readonly key: LocalKey;
}

export interface DirtEventPayloads {
  /** The room rose to `dirty`. */
  roomDirty: RoomEvent;
  /** The room rose to `filthy` (the ship's own failing; `host.slowDownOnEvents` lists it). */
  roomFilthy: RoomEvent;
  /** The room fell back below `dirty`. */
  roomTidied: RoomEvent;
  /** `compartmentDirty` resolved while `byActorId` held its task. */
  roomCleaned: RoomEvent & { readonly byActorId: ActorId };
}

export const DIRT_EVENT_SIGNIFICANCE = {
  roomDirty: "notable",
  roomFilthy: "narrative",
  roomTidied: "trace",
  roomCleaned: "notable",
} as const satisfies SignificanceCatalog<DirtEventPayloads>;
