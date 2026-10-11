/** Registration entry point for the commerce system (PLAN §6 W6). */
import type { KernelRegistry } from "../../core/registry";
import {
  acceptContract,
  declineJob,
  endPassage,
  offerJob,
  spawnAtBoundary,
  stockMarket,
} from "./command-handlers";
import { commerceSystem } from "./commerce";
import { transact } from "./transact";

export function registerCommerce(registry: KernelRegistry): void {
  registry.registerSystem(commerceSystem);
  registry.registerCommandHandler("offerJob", offerJob);
  registry.registerCommandHandler("acceptContract", acceptContract);
  registry.registerCommandHandler("declineJob", declineJob);
  registry.registerCommandHandler("spawnAtBoundary", spawnAtBoundary);
  registry.registerCommandHandler("stockMarket", stockMarket);
  registry.registerCommandHandler("endPassage", endPassage);
  registry.registerCommandHandler("transact", transact);
}

export {
  PASSENGER_CREW_DEF_ID,
  PASSENGER_OVERDUE_PROMPT_KEY,
} from "./passage";
export { commerceTaskDerivations } from "./tasks";
export { affordableUnits } from "../../core/markets";
export { marketBlock } from "./market";
export { PAY_TIER_FRACTION, type PayTier, errandPay } from "./errand";
export { checkErrandBand } from "./jobs";
