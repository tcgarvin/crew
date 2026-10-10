/**
 * Travel commands (SD §17.1).
 */
import type { HazardKind } from "../content";
import type { MachineId, PortDefId } from "../ids";

export interface TravelCommandPayloads {
  /** While docked: choose the next destination; the crew prepare and depart. */
  setCourse: { readonly destinationPortId: PortDefId };
  /**
   * §departure-gate "Hold for repairs": keep the planned departure but wait until no
   * engine/generator is impaired, then depart on our own. `machineId` is the machine the card
   * named.
   */
  holdDepartureForRepairs: { readonly machineId: MachineId };
  /** §departure-gate "Leave anyway": depart as we are; the gate does not ask again this docking. */
  acceptDepartureRisk: { readonly machineId: MachineId };
  /**
   * §debris-fields-and-ion-storms, narrator: a navigation hazard of piloting `difficulty` (an
   * integer in [1, 10]) somewhere in `windowTicks` (relative to the apply tick, sampled on the
   * `failures` stream as `scheduleFault`), fired at the first `transit` tick at or after it. Valid
   * while a course is planned or the ship is underway; spends `narrator.budget.hazardsRemaining`.
   */
  scheduleHazard: {
    readonly kind: HazardKind;
    readonly difficulty: number;
    readonly windowTicks: readonly [number, number];
  };
}
