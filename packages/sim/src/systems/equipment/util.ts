import type { EventDraft, EventPayloadMap, EventType } from "../../core/types/events";
import type { MachineId } from "../../core/types/ids";

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** A sim-sourced event about `machineId`, located at it, with no causes. */
export function machineEvent<T extends EventType>(
  type: T,
  machineId: MachineId,
  payload: EventPayloadMap[T],
): EventDraft {
  return {
    type,
    subjectIds: [machineId],
    causeIds: [],
    source: "sim",
    locationRef: { kind: "machine", machineId },
    payload,
  } as EventDraft;
}
