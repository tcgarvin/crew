/** Registration entry point for the commerce system (PLAN §6 W6). */
import type { KernelRegistry } from "../../core/registry";
import { acceptContract, declineJob, offerJob, spawnAtBoundary } from "./command-handlers";
import { commerceSystem } from "./commerce";

export function registerCommerce(registry: KernelRegistry): void {
  registry.registerSystem(commerceSystem);
  registry.registerCommandHandler("offerJob", offerJob);
  registry.registerCommandHandler("acceptContract", acceptContract);
  registry.registerCommandHandler("declineJob", declineJob);
  registry.registerCommandHandler("spawnAtBoundary", spawnAtBoundary);
}

export { commerceSystem } from "./commerce";
export { spawnAtBoundary } from "./command-handlers";
export {
  checkPriceBand,
  cargoClassOf,
  deliveryComplete,
  acceptJob,
  raiseUnloadProblems,
  payJobIfDue,
  expireStaleOffers,
  routeDistance,
  spawnCargoItem,
  cargoStowageZoneKey,
} from "./jobs";
export { commerceTaskDerivations } from "./tasks";
