/** Travel events (W6). */
import type { MachineId, PortDefId } from "../ids";
import type { TravelStage } from "../travel";
import type { SignificanceCatalog } from "./significance";

export interface TravelEventPayloads {
  travelStageChanged: { readonly from: TravelStage; readonly to: TravelStage };
  departed: { readonly fromPortId: PortDefId; readonly toPortId: PortDefId };
  arrived: { readonly portId: PortDefId };
  driftingChanged: { readonly drifting: boolean };
  /** D36: the captain chose to wait for repairs to `machineId` before departing. */
  departureHeld: { readonly machineId: MachineId };
  /** D36: the captain chose to depart with `machineId` impaired. */
  departureRiskAccepted: { readonly machineId: MachineId };
  /** D36: a hold ended because no engine/generator is impaired any more; departure proceeds. */
  departureHoldLifted: { readonly toPortId: PortDefId };
}

export const TRAVEL_EVENT_SIGNIFICANCE = {
  travelStageChanged: "trace",
  departed: "narrative",
  arrived: "narrative",
  driftingChanged: "narrative",
  departureHeld: "narrative",
  departureRiskAccepted: "narrative",
  departureHoldLifted: "narrative",
} as const satisfies SignificanceCatalog<TravelEventPayloads>;
