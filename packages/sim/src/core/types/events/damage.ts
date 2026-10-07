/**
 * Damage events (D93, D94): the crew's answer to the rocks: scouts sent, scars patched and
 * plated, impact damage repaired.
 */
import type { ActorId, CompartmentId, MachineId, ScarId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface DamageEventPayloads {
  /** The officer of the watch `officerId` sent `scoutId` to look at `compartmentId`. */
  scoutSent: {
    readonly officerId: ActorId;
    readonly scoutId: ActorId;
    readonly compartmentId: CompartmentId;
  };
  /** `actorId` welded a patch kit over scar `scarId`, giving back `recovered` hull points. */
  hullPatched: {
    readonly actorId: ActorId;
    readonly scarId: ScarId;
    readonly compartmentId: CompartmentId;
    readonly recovered: number;
  };
  /** `actorId` plated over scar `scarId`, giving back `recovered`; the scar is gone. */
  hullPlated: {
    readonly actorId: ActorId;
    readonly scarId: ScarId;
    readonly compartmentId: CompartmentId;
    readonly recovered: number;
  };
  /** `actorId` repaired the impact damage to `machineId`; its integrity is whole. */
  machineMended: { readonly actorId: ActorId; readonly machineId: MachineId };
}

export const DAMAGE_EVENT_SIGNIFICANCE = {
  scoutSent: "notable",
  hullPatched: "notable",
  hullPlated: "notable",
  machineMended: "notable",
} as const satisfies SignificanceCatalog<DamageEventPayloads>;
