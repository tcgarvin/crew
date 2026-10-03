/** Registration entry point for the travel system (PLAN §6 W6). */
import type { KernelRegistry } from "../../core/registry";
import { acceptDepartureRisk, holdDepartureForRepairs, setCourse } from "./command-handlers";
import { localsSystem } from "./locals";
import { stageDock } from "./staging";
import { travelSystem } from "./travel";

/**
 * Travel, and with it the dock's lifetime: the locals on it walk in phase `actions` (D66) and
 * the staging call's `stageDock` answer is travel's to apply.
 */
export function registerTravel(registry: KernelRegistry): void {
  registry.registerSystem(localsSystem);
  registry.registerSystem(travelSystem);
  registry.registerCommandHandler("stageDock", stageDock);
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
export { localsSystem, standingOn } from "./locals";
export { stageDock, stagingAnswered } from "./staging";
export { takeCratesIntoStore, withdrawJobCrates } from "./dock-custody";
