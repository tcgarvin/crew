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

export function registerCommerce(registry: KernelRegistry): void {
  registry.registerSystem(commerceSystem);
  registry.registerCommandHandler("offerJob", offerJob);
  registry.registerCommandHandler("acceptContract", acceptContract);
  registry.registerCommandHandler("declineJob", declineJob);
  registry.registerCommandHandler("spawnAtBoundary", spawnAtBoundary);
  registry.registerCommandHandler("stockMarket", stockMarket);
  registry.registerCommandHandler("endPassage", endPassage);
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
export { checkPassageBand, jobFulfilled } from "./jobs";
export {
  PASSENGER_CREW_DEF_ID,
  PASSENGER_OVERDUE_PROMPT_KEY,
  loungeLocation,
  overdueCardRaised,
  passengerSpawnTile,
  sweepPassages,
} from "./passage";
export { commerceTaskDerivations } from "./tasks";
export { affordableUnits, buyFromMarket, marketBlock, type MarketBlock } from "./market";
