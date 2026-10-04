/**
 * The watch (D77): sections and the bell, duty, the helm as the duty station, gangway watch,
 * rounds. Register after `registerNeeds` (same phase; the bell follows the needs update).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { watchSystem } from "./watch";

export function registerWatch(registry: KernelRegistry): Unregister {
  return registry.registerSystem(watchSystem);
}

export { type WatchBill, type WatchBillSection, generateWatchBill, watchBillOf } from "./bill";
export { isOnDuty, isOnWatch } from "./duty";
export {
  helmMachine,
  helmManned,
  helmRoleOf,
  isOfficerOfTheWatch,
  whoHasTheHelm,
} from "./helm";
export { watchSystem } from "./watch";
