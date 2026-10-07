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
import { CABINS_EVENT_SIGNIFICANCE, type CabinsEventPayloads } from "./cabins";
import { COMMERCE_EVENT_SIGNIFICANCE, type CommerceEventPayloads } from "./commerce";
import { DAMAGE_EVENT_SIGNIFICANCE, type DamageEventPayloads } from "./damage";
import { DECISION_EVENT_SIGNIFICANCE, type DecisionEventPayloads } from "./decisions";
import { DIRT_EVENT_SIGNIFICANCE, type DirtEventPayloads } from "./dirt";
import { EQUIPMENT_EVENT_SIGNIFICANCE, type EquipmentEventPayloads } from "./equipment";
import { FIELD_EVENT_SIGNIFICANCE, type FieldEventPayloads } from "./field";
import { GALLEY_EVENT_SIGNIFICANCE, type GalleyEventPayloads } from "./galley";
import { INTERCOM_EVENT_SIGNIFICANCE, type IntercomEventPayloads } from "./intercom";
import { KERNEL_EVENT_SIGNIFICANCE, type KernelEventPayloads } from "./kernel";
import { NEEDS_EVENT_SIGNIFICANCE, type NeedsEventPayloads } from "./needs";
import { PERCEPTION_EVENT_SIGNIFICANCE, type PerceptionEventPayloads } from "./perception";
import { RECREATION_EVENT_SIGNIFICANCE, type RecreationEventPayloads } from "./recreation";
import type { Significance, SignificanceCatalog } from "./significance";
import { SOCIAL_EVENT_SIGNIFICANCE, type SocialEventPayloads } from "./social";
import { SPATIAL_EVENT_SIGNIFICANCE, type SpatialEventPayloads } from "./spatial";
import { TRAVEL_EVENT_SIGNIFICANCE, type TravelEventPayloads } from "./travel";
import { WATCH_EVENT_SIGNIFICANCE, type WatchEventPayloads } from "./watch";
import { WORK_EVENT_SIGNIFICANCE, type WorkEventPayloads } from "./work";

export type * from "./cabins";
export type * from "./commerce";
export type * from "./damage";
export type * from "./decisions";
export type * from "./dirt";
export type * from "./equipment";
export type * from "./field";
export type * from "./galley";
export type * from "./intercom";
export type * from "./kernel";
export type * from "./needs";
export type * from "./perception";
export type * from "./recreation";
export type * from "./significance";
export type * from "./social";
export type * from "./spatial";
export type * from "./travel";
export type * from "./watch";
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
    DecisionEventPayloads,
    WatchEventPayloads,
    GalleyEventPayloads,
    DirtEventPayloads,
    RecreationEventPayloads,
    SocialEventPayloads,
    CabinsEventPayloads,
    FieldEventPayloads,
    DamageEventPayloads,
    IntercomEventPayloads {}

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
  ...WATCH_EVENT_SIGNIFICANCE,
  ...GALLEY_EVENT_SIGNIFICANCE,
  ...DIRT_EVENT_SIGNIFICANCE,
  ...RECREATION_EVENT_SIGNIFICANCE,
  ...SOCIAL_EVENT_SIGNIFICANCE,
  ...CABINS_EVENT_SIGNIFICANCE,
  ...FIELD_EVENT_SIGNIFICANCE,
  ...DAMAGE_EVENT_SIGNIFICANCE,
  ...INTERCOM_EVENT_SIGNIFICANCE,
};

/**
 * The asteroid-field family (slice 5, D92-D94): the field, the crew's damage work and the
 * intercom. The beats report counts their ticker lines per field.
 */
export const FIELD_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  ...(Object.keys(FIELD_EVENT_SIGNIFICANCE) as EventType[]),
  ...(Object.keys(DAMAGE_EVENT_SIGNIFICANCE) as EventType[]),
  ...(Object.keys(INTERCOM_EVENT_SIGNIFICANCE) as EventType[]),
]);

/**
 * The off-watch family (slice 4, D84-D87): recreation, social and cabin events. The beats report
 * counts their ticker lines per watch against call 22's twelve.
 */
export const OFF_WATCH_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  ...(Object.keys(RECREATION_EVENT_SIGNIFICANCE) as EventType[]),
  ...(Object.keys(SOCIAL_EVENT_SIGNIFICANCE) as EventType[]),
  ...(Object.keys(CABINS_EVENT_SIGNIFICANCE) as EventType[]),
]);

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
  [T in EventType]: Omit<EventEnvelope<T>, "id" | "tick" | "seq" | "significance"> & {
    /** Override the catalog default. */
    readonly significance?: Significance;
  };
}[EventType];
