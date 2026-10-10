/**
 * The watch (§sections-and-dayworkers): sections and the bell, duty, the helm as the duty station,
 * gangway watch, rounds. Register after `registerNeeds` (same phase; the bell follows the needs
 * update).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { watchSystem } from "./watch";

export function registerWatch(registry: KernelRegistry): Unregister {
  return registry.registerSystem(watchSystem);
}

export { type WatchBill, type WatchBillSection, generateWatchBill, watchBillOf } from "./bill";
export { isOnDuty, isOnWatch, isSleepWatch, sleepWatchOf } from "./duty";
export {
  gangwayStanderOf,
  helmMachine,
  helmManned,
  helmRoleOf,
  helmWatchOf,
  isOfficerOfTheWatch,
  whoHasTheHelm,
} from "./helm";
export { watchSystem } from "./watch";
