/** Spatial events (W3): movement and doors; crossing a ramp to or from the dock (D61). */
import type { TileCoord } from "../common";
import type { CompartmentId, DoorId } from "../ids";
import type { DoorPhysicalState } from "../ship";
import type { SignificanceCatalog } from "./significance";

export interface SpatialEventPayloads {
  enteredCompartment: {
    readonly compartmentId: CompartmentId;
    readonly fromCompartmentId?: CompartmentId;
  };
  doorStateChanged: {
    readonly doorId: DoorId;
    readonly from: DoorPhysicalState;
    readonly to: DoorPhysicalState;
  };
  doorJammed: { readonly doorId: DoorId };
  /** Execution met an obstruction the actor did not know about (SD §7.2). */
  routeBlocked: { readonly tile: TileCoord; readonly doorId?: DoorId };
  /** W3 addition: a route completed; the actor stands at the centre of `tile`. */
  reachedTile: { readonly tile: TileCoord };
  /** Dockside (D61): a step down `rampId` from the ship onto the dock alongside. */
  wentAshore: { readonly rampId: DoorId };
  /** Dockside (D61): a step up `rampId` from the dock back aboard. */
  cameAboard: { readonly rampId: DoorId };
}

export const SPATIAL_EVENT_SIGNIFICANCE = {
  enteredCompartment: "trace",
  doorStateChanged: "trace",
  doorJammed: "notable",
  routeBlocked: "trace",
  reachedTile: "trace",
  wentAshore: "trace",
  cameAboard: "trace",
} as const satisfies SignificanceCatalog<SpatialEventPayloads>;
