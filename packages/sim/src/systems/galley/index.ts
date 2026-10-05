/**
 * The galley (D81): meals cooked before each bell from provisions, served on the counter, eaten at
 * the mess tables; the provisions reserve. Register after `registerWatch` (same phase; the meal
 * follows the bell).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { galleySystem } from "./galley";

export function registerGalley(registry: KernelRegistry): Unregister {
  return registry.registerSystem(galleySystem);
}

export { consumeServing, eatPlan, mealCallStandsFor, runConsume } from "./eat";
export { galleySystem } from "./galley";
export {
  cratesPerDay,
  eatersAboard,
  mealDef,
  provisionsCratesAboard,
  provisionsDays,
  provisionsDefs,
  servingsPerMeal,
} from "./provisions";
export { galleyTaskDerivations } from "./tasks";
