/**
 * The full V1 kernel registry (Integration 2), shared by the worker and the headless tests so
 * both run exactly the same systems in the same order (W4a's order):
 *
 * spatial → power + equipment → dirt (§dirt-grid) → travel + commerce → needs → watch (§the-bell) →
 * galley (§meal-problem) → recreation, social, cabins (slice 4: off watch) → damage, intercom
 * (slice 5: the crew's answer to the rocks) → medical (§medicine) → work (execution, perception, chat, derivation with
 * every system's rules, AgentView builder) → planner. The field (slice 5) registers after travel,
 * so it runs after travel's hazards in the equipment phase. Expeditions A1: bodies after needs (the
 * needs phase), the expedition just before work (the actions phase: after spatial, before
 * `work.execute`).
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
  medicalTaskDerivations,
  registerBodies,
  registerCabins,
  registerCommerce,
  registerDamage,
  registerDirt,
  registerEquipmentSystems,
  registerExpedition,
  registerField,
  registerGalley,
  registerIntercom,
  registerMedical,
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
  // Expeditions A1: bodies after needs in the needs phase (call 5).
  registerBodies(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerRecreation(registry);
  registerSocial(registry);
  registerCabins(registry);
  registerDamage(registry);
  registerIntercom(registry);
  // §medicine: the wounded problem, after the bodies system in the needs phase.
  registerMedical(registry);
  // Expeditions A1: the muster and the fight, in the actions phase after spatial, before work.
  registerExpedition(registry);
  // `registerWork` also installs the AgentView builder (the inspector reads it).
  registerWork(registry, {
    derivations: {
      ...equipmentTaskDerivation,
      ...travelTaskDerivations,
      ...commerceTaskDerivations,
      ...galleyTaskDerivations,
      ...dirtTaskDerivations,
      ...damageTaskDerivations,
      ...medicalTaskDerivations,
    },
    stages: equipmentStages,
  });
  registerPlannerDefaults(registry);
  return registry;
}
