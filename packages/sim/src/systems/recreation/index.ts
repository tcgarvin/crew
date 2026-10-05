/**
 * Recreation (slice 4): the fifth need's activities, group sessions at their venues, the
 * `recreate` step and plan. Register after `registerGalley` (same phase, after needs and mood).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { recreationSystem } from "./recreation";

export function registerRecreation(registry: KernelRegistry): Unregister {
  return registry.registerSystem(recreationSystem);
}

export { recreationRatesFor } from "./needs";
export { recreatePlan } from "./plans";
export { recreationSystem } from "./recreation";
export { joinSession, leaveRecreation, openSession } from "./sessions";
export { runRecreate } from "./steps";
export { type ResolvedVenue, resolveVenue } from "./venues";
