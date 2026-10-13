/**
 * Bodies (expeditions A1, §7.1): wounds over time and the one damage entry point. Register after
 * `registerNeeds` (the bodies system runs after `needs.needs` in phase `needs`).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { accidentsSystem } from "./accidents";
import { bodiesSystem } from "./bodies";
import { strike } from "./strike";

/**
 * The bodies system, then accidents aboard (§accidents-aboard), and the narrator's `strike`
 * (§strike-lever).
 */
export function registerBodies(registry: KernelRegistry): Unregister {
  const unregister = [
    registry.registerSystem(bodiesSystem),
    registry.registerSystem(accidentsSystem),
    registry.registerCommandHandler("strike", strike),
  ];
  return () => {
    for (const undo of unregister) undo();
  };
}

export { accidentsSystem, thrownByImpact } from "./accidents";
export { bodiesSystem } from "./bodies";
export { type DamageResult, type Hit, applyDamage } from "./damage";
export { goDown } from "./down";
export { strike } from "./strike";
