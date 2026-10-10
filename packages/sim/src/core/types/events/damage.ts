/**
 * Damage events (§patching-and-plating, §scouts): the crew's answer to the rocks: scouts sent,
 * scars patched and plated, impact damage repaired.
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

/**
 * Slice-5 integration: `scoutSent` and `hullPatched` are trace. A field sends a scout to most
 * rooms once and leaves a patch a rock, and those lines (a dozen and seven a brutal field) drowned
 * the ticker's reports and knockouts; the scouts and patchers show on the deck ("checking the
 * hold", "patching the hull in the hold"), the hull bar rises with each patch, and the beats
 * report counts both. Plating at port and a machine mended stay notable: they are rarer, and
 * each is a repair finished.
 */
export const DAMAGE_EVENT_SIGNIFICANCE = {
  scoutSent: "trace",
  hullPatched: "trace",
  hullPlated: "notable",
  machineMended: "notable",
} as const satisfies SignificanceCatalog<DamageEventPayloads>;
