/**
 * Intercom panels (slice 5, D94): the reporting reflex and the broadcast. Register after
 * `registerDamage`. The intercom has no system of its own (the reflex is the planner's,
 * `planner/intercom.ts`, and the broadcast the `report` step's, `report.ts`); the function exists
 * so the hosts' registration never changes if it gains one.
 */
import type { KernelRegistry, Unregister } from "../../core/registry";

export function registerIntercom(_registry: KernelRegistry): Unregister {
  return () => {};
}

export { reportLabel } from "./labels";
export { reportPlan } from "./plans";
export { runReport } from "./report";
