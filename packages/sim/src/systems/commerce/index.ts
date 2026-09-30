/** Registration entry point for the commerce system (PLAN §6 W6). */
import type { KernelRegistry } from "../../core/registry";
import { acceptContract, declineJob, offerJob } from "./command-handlers";
import { commerceSystem } from "./commerce";

export function registerCommerce(registry: KernelRegistry): void {
  registry.registerSystem(commerceSystem);
  registry.registerCommandHandler("offerJob", offerJob);
  registry.registerCommandHandler("acceptContract", acceptContract);
  registry.registerCommandHandler("declineJob", declineJob);
}

export { commerceSystem } from "./commerce";
export {
  checkPriceBand,
  cargoClassOf,
  deliveryComplete,
  acceptJob,
  raiseUnloadProblems,
  payJobIfDue,
  expireStaleOffers,
  routeDistance,
} from "./jobs";
export { runJobSource } from "./jobSource";
export { commerceTaskDerivations } from "./tasks";
