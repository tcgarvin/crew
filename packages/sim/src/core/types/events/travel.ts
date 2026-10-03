/** Travel events (W6). */
import type { ActorId, DockDefId, ItemId, LocalId, MachineId, PortDefId } from "../ids";
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
  /**
   * D61: someone on the dock could not walk back aboard while the ship was leaving (they cannot
   * move, or their walk failed), so the dock crew brought them up the ramp. The departure is never
   * held forever, and never silently.
   */
  broughtAboard: { readonly actorId: ActorId; readonly name: string; readonly portId: PortDefId };
  /** D61: an item was still on the dock when it slid away; it stays at the port's warehouse. */
  leftOnDock: { readonly itemId: ItemId; readonly portId: PortDefId };
  /**
   * D65: a piece of the ship's own gear (the hand truck) was still on the dock when it went, so
   * the dock crew handed it up the cargo ramp instead of leaving it at the warehouse.
   */
  gearBroughtAboard: { readonly itemId: ItemId; readonly portId: PortDefId };
  /**
   * D66: the dock alongside was dressed: the floor set and the staging plan's people (`localIds`)
   * and props. `unplaced` names anyone the dock had no room for near their post. `staged` is
   * whether a staging plan was applied (false: the floor set alone).
   */
  dockDressed: {
    readonly portId: PortDefId;
    readonly dockId: DockDefId;
    readonly localIds: readonly LocalId[];
    readonly props: number;
    readonly staged: boolean;
    readonly unplaced: readonly string[];
  };
  /** D66: the staging plan's one line for the log as the dock comes alongside. */
  dockAmbience: { readonly portId: PortDefId; readonly line: string };
}

export const TRAVEL_EVENT_SIGNIFICANCE = {
  travelStageChanged: "trace",
  departed: "narrative",
  arrived: "narrative",
  driftingChanged: "narrative",
  departureHeld: "narrative",
  departureRiskAccepted: "narrative",
  departureHoldLifted: "narrative",
  broughtAboard: "notable",
  leftOnDock: "notable",
  gearBroughtAboard: "notable",
  dockDressed: "trace",
  // The staging call sets the stage and never moves the plot (D57): shown, never narrative.
  dockAmbience: "notable",
} as const satisfies SignificanceCatalog<TravelEventPayloads>;
