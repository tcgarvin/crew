/**
 * The asteroid field (slice 5, D92): `scheduleField` and the field system. Register after
 * `registerTravel` (the field runs after travel's hazards in the `equipment` phase).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { scheduleField } from "./command";
import { fieldSystem } from "./field";

export function registerField(registry: KernelRegistry): Unregister {
  const unregister = [
    registry.registerSystem(fieldSystem),
    registry.registerCommandHandler("scheduleField", scheduleField),
  ];
  return () => {
    for (const undo of unregister) undo();
  };
}

export { scheduleField, scriptedHullDamage } from "./command";
export { fieldSystem } from "./field";
export { fieldViolations } from "./invariants";
