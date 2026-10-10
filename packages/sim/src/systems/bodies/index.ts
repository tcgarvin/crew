/**
 * Bodies (expeditions A1, §7.1): wounds over time and the one damage entry point. Register after
 * `registerNeeds` (the bodies system runs after `needs.needs` in phase `needs`).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { bodiesSystem } from "./bodies";

export function registerBodies(registry: KernelRegistry): Unregister {
  return registry.registerSystem(bodiesSystem);
}

export { bodiesSystem } from "./bodies";
export { type DamageResult, type Hit, applyDamage } from "./damage";
