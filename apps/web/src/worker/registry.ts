/**
 * The full V1 kernel registry (Integration 2), shared by the worker and the headless tests so
 * both run exactly the same systems in the same order (W4a's order):
 *
 * spatial → power + equipment → dirt (§dirt-grid) → travel + commerce → needs → watch (§the-bell) →
 * galley (§meal-problem) → recreation, social, cabins (slice 4: off watch) → damage, intercom
 * (slice 5: the crew's answer to the rocks) → work (execution, perception, chat, derivation with
 * every system's rules, AgentView builder) → planner. The field (slice 5) registers after travel,
 * so it runs after travel's hazards in the equipment phase.
 */
import {
  type KernelRegistry,
  commerceTaskDerivations,
  createRegistry,
  damageTaskDerivations,
  dirtTaskDerivations,
  equipmentStages,
  equipmentTaskDerivation,
  galleyTaskDerivations,
  registerCabins,
  registerCommerce,
  registerDamage,
  registerDirt,
  registerEquipmentSystems,
  registerField,
  registerGalley,
  registerIntercom,
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
  registerField(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerRecreation(registry);
  registerSocial(registry);
  registerCabins(registry);
  registerDamage(registry);
  registerIntercom(registry);
  // `registerWork` also installs the AgentView builder (the inspector reads it).
  registerWork(registry, {
    derivations: {
      ...equipmentTaskDerivation,
      ...travelTaskDerivations,
      ...commerceTaskDerivations,
      ...galleyTaskDerivations,
      ...dirtTaskDerivations,
      ...damageTaskDerivations,
    },
    stages: equipmentStages,
  });
  registerPlannerDefaults(registry);
  return registry;
}
