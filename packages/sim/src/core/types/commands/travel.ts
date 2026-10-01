/**
 * Travel commands (SD §17.1).
 */
import type { MachineId, PortDefId } from "../ids";

export interface TravelCommandPayloads {
  /** While docked: choose the next destination; the crew prepare and depart. */
  setCourse: { readonly destinationPortId: PortDefId };
  /**
   * D36 "Hold for repairs": keep the planned departure but wait until no engine/generator is
   * impaired, then depart on our own. `machineId` is the machine the card named.
   */
  holdDepartureForRepairs: { readonly machineId: MachineId };
  /** D36 "Leave anyway": depart as we are; the gate does not ask again this docking. */
  acceptDepartureRisk: { readonly machineId: MachineId };
}
