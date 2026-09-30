/**
 * The full V1 kernel registry (Integration 2), shared by the worker and the headless tests so
 * both run exactly the same systems in the same order (W4a's order):
 *
 * spatial → power + equipment → travel + commerce → needs → work (execution, perception, chat,
 * derivation with every system's rules, AgentView builder) → planner.
 */
import {
  type KernelRegistry,
  commerceTaskDerivations,
  createRegistry,
  equipmentStages,
  equipmentTaskDerivation,
  registerCommerce,
  registerEquipmentSystems,
  registerNeeds,
  registerPlannerDefaults,
  registerSpatial,
  registerTravel,
  registerWork,
  travelTaskDerivations,
} from "@crew/sim";

export function createFullRegistry(): KernelRegistry {
  const registry = createRegistry();
  registerSpatial(registry);
  registerEquipmentSystems(registry);
  registerTravel(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  // `registerWork` also installs the AgentView builder (the inspector reads it).
  registerWork(registry, {
    derivations: {
      ...equipmentTaskDerivation,
      ...travelTaskDerivations,
      ...commerceTaskDerivations,
    },
    stages: equipmentStages,
  });
  registerPlannerDefaults(registry);
  return registry;
}
