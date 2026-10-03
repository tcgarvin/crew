/** Registration entry point for the travel system (PLAN §6 W6). */
import type { KernelRegistry } from "../../core/registry";
import { acceptDepartureRisk, holdDepartureForRepairs, setCourse } from "./command-handlers";
import { travelSystem } from "./travel";

export function registerTravel(registry: KernelRegistry): void {
  registry.registerSystem(travelSystem);
  registry.registerCommandHandler("setCourse", setCourse);
  registry.registerCommandHandler("holdDepartureForRepairs", holdDepartureForRepairs);
  registry.registerCommandHandler("acceptDepartureRisk", acceptDepartureRisk);
}

export { travelSystem } from "./travel";
export {
  hasOpenCargoWork,
  hasRunnableBuyPartsWork,
  propulsionFactor,
  portStoreLocation,
  theDeckId,
  voyageHeldAtWaypoint,
  waitingForPassenger,
} from "./travel";
export { hopCount, nextHop, shortestPath, type ShortestPath } from "./graph";
export { commandActor, isFitForCommand } from "./roster";
export { raiseHookIfIdle, raiseJobBoardHookIfNeeded } from "./hooks";
export {
  DEPARTURE_GATE_PROMPT_KEY,
  departureCleared,
  impairmentKey,
  worstImpairment,
} from "./departure-gate";
export { jobBlockingAcceptance } from "./in-hand";
export { travelTaskDerivations } from "./tasks";
export { travelViolations } from "./invariants";
