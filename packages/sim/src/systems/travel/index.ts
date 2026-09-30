/** Registration entry point for the travel system (PLAN §6 W6). */
import type { KernelRegistry } from "../../core/registry";
import { setCourse } from "./command-handlers";
import { travelSystem } from "./travel";

export function registerTravel(registry: KernelRegistry): void {
  registry.registerSystem(travelSystem);
  registry.registerCommandHandler("setCourse", setCourse);
}

export { travelSystem } from "./travel";
export { propulsionFactor, portStoreLocation, theDeckId } from "./travel";
export { commandActor, isFitForCommand } from "./roster";
export { raiseHookIfIdle, raiseJobBoardHookIfNeeded } from "./hooks";
export { travelTaskDerivations } from "./tasks";
