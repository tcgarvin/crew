/**
 * Travel commands (SD §17.1).
 */
import type { PortDefId } from "../ids";

export interface TravelCommandPayloads {
  /** While docked: choose the next destination; the crew prepare and depart. */
  setCourse: { readonly destinationPortId: PortDefId };
}
