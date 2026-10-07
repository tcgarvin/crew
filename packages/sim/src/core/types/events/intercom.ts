/** Intercom events (D94): a report on the intercom, which everyone aboard hears. */
import type { ActorId, CompartmentId, MachineId } from "../ids";
import type { SignificanceCatalog } from "./significance";

/** D94: one piece of damage a report names. */
export type ReportedDamage =
  | { readonly kind: "scar"; readonly compartmentId: CompartmentId }
  | { readonly kind: "machine"; readonly machineId: MachineId; readonly out: boolean };

export interface IntercomEventPayloads {
  /**
   * `actorId` reported `damage` on the intercom at panel `panelId` in `compartmentId` (where the
   * panel is); every crew member aboard now holds it as `report` evidence.
   */
  intercomReport: {
    readonly actorId: ActorId;
    readonly panelId: MachineId;
    readonly compartmentId: CompartmentId;
    readonly damage: readonly ReportedDamage[];
  };
}

export const INTERCOM_EVENT_SIGNIFICANCE = {
  intercomReport: "notable",
} as const satisfies SignificanceCatalog<IntercomEventPayloads>;
