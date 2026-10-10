/**
 * Dirt (§dirt-grid): a quantised grid per deck fed by footfall, boots, dust and deposits; room
 * tiers; the `compartmentDirty` problem and its mop task. Register after `registerEquipmentSystems`
 * (same phase).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { dirtSystem } from "./dirt";

export function registerDirt(registry: KernelRegistry): Unregister {
  return registry.registerSystem(dirtSystem);
}

export { cleanPlan, runMop } from "./clean";
export { depositDirt } from "./deposit";
export { dirtPassDue, dirtSystem } from "./dirt";
export { trackFootfall } from "./footfall";
export { roomDirt, tierOf } from "./grid";
export { dirtViolations } from "./invariants";
export { dirtTaskDerivations } from "./tasks";
