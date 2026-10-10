import type { EventDraft, EventPayloadMap, EventType } from "../../core/types/events";
import type { CommandId, EventId, MachineId } from "../../core/types/ids";

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * A sim-sourced event about `machineId`, located at it, with `causeIds` (none by default;
 * §notable-event-hook: a repair carries the command that caused its fault).
 */
export function machineEvent<T extends EventType>(
  type: T,
  machineId: MachineId,
  payload: EventPayloadMap[T],
  causeIds: readonly (EventId | CommandId)[] = [],
): EventDraft {
  return {
    type,
    subjectIds: [machineId],
    causeIds: [...causeIds],
    source: "sim",
    locationRef: { kind: "machine", machineId },
    payload,
  } as EventDraft;
}
