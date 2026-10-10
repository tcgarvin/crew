/**
 * Watch events (§the-bell, §thoughts): the bell, the helm's handovers and vacancies, gangway watch,
 * thoughts.
 */
import type { ThoughtKey } from "../content";
import type { ActorId, LocalKey, MachineId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface WatchEventPayloads {
  /**
   * The watch changed: `watchIndex` is `watchIndexAt` of the new watch, `sectionKey` the section
   * that has it (absent when no section stands this watch of the day).
   */
  bell: { readonly watchIndex: number; readonly sectionKey?: LocalKey };
  /** `byActorId` took the helm `machineId` from `fromActorId` (absent: nobody held it). */
  helmRelieved: {
    readonly machineId: MachineId;
    readonly byActorId: ActorId;
    readonly fromActorId?: ActorId;
  };
  /** Nobody has been at the helm `machineId` for `seconds` in transit (once per vacancy). */
  helmUnattended: { readonly machineId: MachineId; readonly seconds: number };
  /** `actorId` took up gangway watch at the airlock. */
  gangwayWatchSet: { readonly actorId: ActorId };
  /** `actorId` had the thought `key` (`core/thoughts.ts`). */
  thoughtAdded: { readonly actorId: ActorId; readonly key: ThoughtKey };
}

export const WATCH_EVENT_SIGNIFICANCE = {
  bell: "notable",
  helmRelieved: "notable",
  // The ship's own failing: a fact for the narrator's next call, not a hook (§helm-vacancy).
  helmUnattended: "narrative",
  gangwayWatchSet: "trace",
  thoughtAdded: "trace",
} as const satisfies SignificanceCatalog<WatchEventPayloads>;
