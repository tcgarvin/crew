/**
 * Per-step event buffer (CONTRACTS rule 6, SD §19.3). Systems get only `emit`; nothing can read
 * the buffer back within the tick. `finalize` (phase 8) stamps `id`, `tick`, `seq` and the
 * default significance, and returns the committed `SimEvent`s.
 */
import { type IdHost, allocateId } from "./ids";
import type { Tick } from "./types/common";
import { EVENT_SIGNIFICANCE, type EventDraft, type SimEvent } from "./types/events";

interface EventBuffer {
  /** Collect a draft. The only operation systems see. */
  readonly emit: (draft: EventDraft) => void;
  /**
   * Stamp and return every buffered event in emission order, then empty the buffer. Allocates
   * event IDs from `host.nextId`.
   */
  finalize(host: IdHost, tick: Tick): SimEvent[];
  /** Number of buffered drafts (for the kernel's bookkeeping, not for systems). */
  readonly size: () => number;
}

export function createEventBuffer(): EventBuffer {
  let drafts: EventDraft[] = [];
  return {
    emit(draft) {
      drafts.push(draft);
    },
    size: () => drafts.length,
    finalize(host, tick) {
      const out: SimEvent[] = [];
      drafts.forEach((draft, seq) => {
        out.push(finalizeDraft(draft, allocateId(host, "event"), tick, seq));
      });
      drafts = [];
      return out;
    },
  };
}

function finalizeDraft(draft: EventDraft, id: SimEvent["id"], tick: Tick, seq: number): SimEvent {
  const significance = draft.significance ?? EVENT_SIGNIFICANCE[draft.type];
  const event = {
    id,
    tick,
    seq,
    type: draft.type,
    subjectIds: draft.subjectIds,
    causeIds: draft.causeIds,
    source: draft.source,
    significance,
    payload: draft.payload,
  };
  // Omit rather than write `undefined` (JSON-safe events).
  return (
    draft.locationRef === undefined ? event : { ...event, locationRef: draft.locationRef }
  ) as SimEvent;
}
