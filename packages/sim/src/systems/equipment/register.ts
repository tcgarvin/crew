import type { KernelRegistry } from "../../core/registry";
import { registerPowerSystem } from "../power/power";
import { registerEquipmentCommandHandlers } from "./commands";
import { registerEquipmentSystem } from "./equipment";

/** Register everything W5 owns: power allocation, the equipment tick and `scheduleFault`. */
export function registerEquipmentSystems(registry: KernelRegistry): void {
  registerPowerSystem(registry);
  registerEquipmentSystem(registry);
  registerEquipmentCommandHandlers(registry);
}
