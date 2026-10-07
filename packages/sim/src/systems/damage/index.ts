/**
 * Damage response (slice 5, D93, D94): what the crew do about the rocks. Register after
 * `registerCabins` (same phase); merge `damageTaskDerivations` into `registerWork`'s table.
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { damageSystem } from "./damage";

export function registerDamage(registry: KernelRegistry): Unregister {
  return registry.registerSystem(damageSystem);
}

export { damageSystem } from "./damage";
export { type ImpactReport, damageMachine, onImpact } from "./machines";
export { damageTaskDerivations } from "./tasks";
