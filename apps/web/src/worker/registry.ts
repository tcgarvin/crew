/**
 * The full V1 kernel registry (Integration 2), shared by the worker and the headless tests so
 * both run exactly the same systems in the same order (W4a's order):
 *
 * spatial → power + equipment → dirt (D82) → travel + commerce → needs → watch (D77: the bell) →
 * galley (D81: the meal) → recreation, social, cabins (slice 4: off watch) → work (execution,
 * perception, chat, derivation with every system's rules, AgentView builder) → planner.
 */
import {
  type KernelRegistry,
  commerceTaskDerivations,
  createRegistry,
  dirtTaskDerivations,
  equipmentStages,
  equipmentTaskDerivation,
  galleyTaskDerivations,
  registerCabins,
  registerCommerce,
  registerDirt,
  registerEquipmentSystems,
  registerGalley,
  registerNeeds,
  registerPlannerDefaults,
  registerRecreation,
  registerSocial,
  registerSpatial,
  registerTravel,
  registerWatch,
  registerWork,
  travelTaskDerivations,
} from "@crew/sim";

export function createFullRegistry(): KernelRegistry {
  const registry = createRegistry();
  registerSpatial(registry);
  registerEquipmentSystems(registry);
  registerDirt(registry);
  registerTravel(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerRecreation(registry);
  registerSocial(registry);
  registerCabins(registry);
  // `registerWork` also installs the AgentView builder (the inspector reads it).
  registerWork(registry, {
    derivations: {
      ...equipmentTaskDerivation,
      ...travelTaskDerivations,
      ...commerceTaskDerivations,
      ...galleyTaskDerivations,
      ...dirtTaskDerivations,
    },
    stages: equipmentStages,
  });
  registerPlannerDefaults(registry);
  return registry;
}
