/** Travel events (W6). */
import type { PortDefId } from "../ids";
import type { TravelStage } from "../travel";
import type { SignificanceCatalog } from "./significance";

export interface TravelEventPayloads {
  travelStageChanged: { readonly from: TravelStage; readonly to: TravelStage };
  departed: { readonly fromPortId: PortDefId; readonly toPortId: PortDefId };
  arrived: { readonly portId: PortDefId };
  driftingChanged: { readonly drifting: boolean };
}

export const TRAVEL_EVENT_SIGNIFICANCE = {
  travelStageChanged: "trace",
  departed: "narrative",
  arrived: "narrative",
  driftingChanged: "narrative",
} as const satisfies SignificanceCatalog<TravelEventPayloads>;
