import type { EventDraft, EventPayloadMap, EventType } from "../../core/types/events";
import type { EntityId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";

/** Emit a sim-sourced event with no causes and the catalog significance (every work event). */
export function emitSim<T extends EventType>(
  ctx: Pick<StepCtx, "emit">,
  type: T,
  subjectIds: readonly EntityId[],
  payload: EventPayloadMap[T],
): void {
  ctx.emit({ type, subjectIds, causeIds: [], source: "sim", payload } as EventDraft);
}
