/**
 * The Event union (SD §19.3, review §C.4).
 *
 * Events are **outputs** of `advance()`, never state and never read by a system within the tick
 * that emitted them: cross-system communication goes through state (problems, queues, dirty
 * flags). Systems call `ctx.emit(draft)`; phase 8 assigns `id`, `tick` and `seq` and fills in the
 * default significance. Each system owns one file in this folder exporting `<System>EventPayloads`
 * and a significance catalog; this file merges them.
 */
import type { CommandSource } from "../commands";
import type { LocationRef, Tick } from "../common";
import type { CommandId, EntityId, EventId } from "../ids";
import { COMMERCE_EVENT_SIGNIFICANCE, type CommerceEventPayloads } from "./commerce";
import { DECISION_EVENT_SIGNIFICANCE, type DecisionEventPayloads } from "./decisions";
import { EQUIPMENT_EVENT_SIGNIFICANCE, type EquipmentEventPayloads } from "./equipment";
import { KERNEL_EVENT_SIGNIFICANCE, type KernelEventPayloads } from "./kernel";
import { NEEDS_EVENT_SIGNIFICANCE, type NeedsEventPayloads } from "./needs";
import { PERCEPTION_EVENT_SIGNIFICANCE, type PerceptionEventPayloads } from "./perception";
import type { Significance, SignificanceCatalog } from "./significance";
import { SPATIAL_EVENT_SIGNIFICANCE, type SpatialEventPayloads } from "./spatial";
import { TRAVEL_EVENT_SIGNIFICANCE, type TravelEventPayloads } from "./travel";
import { WORK_EVENT_SIGNIFICANCE, type WorkEventPayloads } from "./work";

export type * from "./commerce";
export type * from "./decisions";
export type * from "./equipment";
export type * from "./kernel";
export type * from "./needs";
export type * from "./perception";
export type * from "./significance";
export type * from "./spatial";
export type * from "./travel";
export type * from "./work";

/** All event payloads keyed by type. To add a system, extend this with its map. */
export interface EventPayloadMap
  extends KernelEventPayloads,
    SpatialEventPayloads,
    WorkEventPayloads,
    EquipmentEventPayloads,
    NeedsEventPayloads,
    PerceptionEventPayloads,
    TravelEventPayloads,
    CommerceEventPayloads,
    DecisionEventPayloads {}

export type EventType = keyof EventPayloadMap;

/** Default significance for every event type. Exhaustive by construction. */
export const EVENT_SIGNIFICANCE: SignificanceCatalog<EventPayloadMap> = {
  ...KERNEL_EVENT_SIGNIFICANCE,
  ...SPATIAL_EVENT_SIGNIFICANCE,
  ...WORK_EVENT_SIGNIFICANCE,
  ...EQUIPMENT_EVENT_SIGNIFICANCE,
  ...NEEDS_EVENT_SIGNIFICANCE,
  ...PERCEPTION_EVENT_SIGNIFICANCE,
  ...TRAVEL_EVENT_SIGNIFICANCE,
  ...COMMERCE_EVENT_SIGNIFICANCE,
  ...DECISION_EVENT_SIGNIFICANCE,
};

/** `sim` for pipeline-originated events; otherwise the source of the command that caused it. */
export type EventSource = CommandSource | "sim";

export interface EventEnvelope<T extends EventType = EventType> {
  readonly id: EventId;
  readonly tick: Tick;
  /** Order within the tick. `(tick, seq)` is total over a run. */
  readonly seq: number;
  readonly type: T;
  /** Actors/machines/items the event is about; the first is the primary subject. */
  readonly subjectIds: readonly EntityId[];
  readonly locationRef?: LocationRef;
  /**
   * What caused this: earlier events and/or the originating command. Every narrator-caused
   * mutation's chain reaches a narrator command ID.
   */
  readonly causeIds: readonly (EventId | CommandId)[];
  readonly source: EventSource;
  readonly significance: Significance;
  readonly payload: EventPayloadMap[T];
}

/**
 * Discriminated union of every event. Narrow on `type`.
 * W0 decision: named `SimEvent`, not `Event`, to avoid shadowing the DOM `Event` global in web code.
 */
export type SimEvent = { [T in EventType]: EventEnvelope<T> }[EventType];

/** What a system passes to `ctx.emit`; phase 8 completes it. */
export type EventDraft = {
  [T in EventType]: {
    readonly type: T;
    readonly subjectIds: readonly EntityId[];
    readonly locationRef?: LocationRef;
    readonly causeIds: readonly (EventId | CommandId)[];
    readonly source: EventSource;
    /** Override the catalog default. */
    readonly significance?: Significance;
    readonly payload: EventPayloadMap[T];
  };
}[EventType];
