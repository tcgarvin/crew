/**
 * Medicine (§medicine): wounds treated at the medbay bed. Register after `registerBodies` (the
 * medical system runs after the bodies system in phase `needs`); merge `medicalTaskDerivations`
 * into `registerWork`'s table.
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { medicalSystem } from "./medical";

export function registerMedical(registry: KernelRegistry): Unregister {
  return registry.registerSystem(medicalSystem);
}

export { medBedOf } from "./bed";
export { medicalSystem } from "./medical";
export { medicalTaskDerivations } from "./tasks";
