/**
 * Field events (§field-lifecycle, §rock-impacts): an asteroid field scheduled, sighted, entered and
 * cleared; each rock that hits; the alert; the ship stuck in the rocks; and the hull giving way.
 */
import type { TileCoord } from "../common";
import type { FieldDetection, FieldSeverity, MachineEffect, RockSize } from "../content";
import type { ActorId, CompartmentId, FieldId, MachineId, PortDefId, ScarId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface FieldEventPayloads {
  /** A `scheduleField` placed field `fieldId` on the leg. */
  fieldScheduled: {
    readonly fieldId: FieldId;
    readonly severity: FieldSeverity;
    readonly detection: FieldDetection;
    readonly scripted: number;
  };
  /**
   * Field `fieldId` never began: the leg it lay on ended first (`fromPortId` → `toPortId`), or
   * (absent `toPortId`) the course was given up in port. Never carried to another leg.
   */
  fieldMissed: {
    readonly fieldId: FieldId;
    readonly fromPortId: PortDefId;
    readonly toPortId?: PortDefId;
  };
  /** The helm-stander `standerId` saw the field coming (`field.warningSeconds` before it). */
  fieldSighted: {
    readonly fieldId: FieldId;
    readonly standerId: ActorId;
    readonly severity: FieldSeverity;
  };
  /**
   * The field's first impact landed. Narrative when nobody aboard had noticed the field (an
   * `unseen` one, a failed check, an empty helm), notable when the helm had sighted it.
   */
  fieldEntered: { readonly fieldId: FieldId; readonly noticedBefore: boolean };
  /**
   * A rock hit the ship at `tile` (deck frame), covering `tiles`, in `compartmentId`: the hull
   * lost `hullDamage` and scar `scarId` marks the spot; each machine in the blast took `effect`.
   */
  asteroidImpact: {
    readonly fieldId: FieldId;
    readonly tile: TileCoord;
    readonly tiles: readonly TileCoord[];
    readonly rock: RockSize;
    readonly compartmentId: CompartmentId;
    readonly hullDamage: number;
    readonly scarId: ScarId;
    readonly scripted: boolean;
    readonly hits: readonly { readonly machineId: MachineId; readonly effect: MachineEffect }[];
  };
  /** An impact took `machineId` from running to inoperable. */
  machineKnockedOut: { readonly fieldId: FieldId; readonly machineId: MachineId };
  /** A rock came through the tile `actorId` stood on (no bodies yet: a fright). */
  nearMiss: {
    readonly fieldId: FieldId;
    readonly actorId: ActorId;
    readonly compartmentId: CompartmentId;
  };
  /** The ship went on alert. */
  alertRaised: { readonly cause: "field"; readonly fieldId: FieldId };
  /** The alert stood down (`field.alertClearSeconds` after the field ended). */
  alertCleared: { readonly cause: "field" };
  /** Engines out inside the field: the ship has stopped making way and is stuck in the rocks. */
  shipStuck: { readonly fieldId: FieldId };
  /** Engines back inside the field: under way again. */
  shipUnstuck: { readonly fieldId: FieldId };
  /**
   * The ship is out of field `fieldId`: crossed it, or drifted clear while stuck (call 9), after
   * `impacts` hits that cost `hullLost`; the hull stands at `integrity` of `max`.
   */
  fieldCleared: {
    readonly fieldId: FieldId;
    readonly how: "crossed" | "drifted";
    readonly impacts: number;
    readonly hullLost: number;
    readonly integrity: number;
    readonly max: number;
  };
  /** The hull reached zero. The run is over. */
  shipLost: { readonly fieldId?: FieldId };
}

export const FIELD_EVENT_SIGNIFICANCE = {
  fieldScheduled: "trace",
  // The narrator's bookkeeping: its field came to nothing. No ticker line.
  fieldMissed: "notable",
  fieldSighted: "narrative",
  // Emitted notable when the field was already sighted, so it hooks only the first knowledge.
  fieldEntered: "narrative",
  asteroidImpact: "notable",
  machineKnockedOut: "notable",
  nearMiss: "notable",
  alertRaised: "notable",
  alertCleared: "notable",
  shipStuck: "narrative",
  shipUnstuck: "notable",
  fieldCleared: "narrative",
  shipLost: "narrative",
} as const satisfies SignificanceCatalog<FieldEventPayloads>;
