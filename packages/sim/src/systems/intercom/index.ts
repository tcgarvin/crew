/**
 * Intercom panels (slice 5, D94): the reporting reflex and the broadcast. Register after
 * `registerDamage`. Nothing runs as a system yet; the function exists so the hosts' registration
 * never changes when the stream adds one.
 */
import type { KernelRegistry, Unregister } from "../../core/registry";

export function registerIntercom(_registry: KernelRegistry): Unregister {
  return () => {};
}

export { reportLabel } from "./labels";
export { reportPlan } from "./plans";
export { runReport } from "./report";
