export * from "./core/index";

/**
 * W0 decision (Integration 1): explicit re-exports from the systems for hosts (the web worker,
 * the CLI, other packages' tests), deliberately not `export *` of `systems/index.ts`. Add names
 * here as a host needs them; `apps/web/src/worker/registry.ts` shows the registration order.
 */
export { checkDockFitsDeck, compartmentAt, registerSpatial } from "./systems/spatial/index";
export { rotateOffset } from "./systems/spatial/geometry";
export { spatialViolations } from "./systems/spatial/invariants";
export {
  commerceTaskDerivations,
  marketBlock,
  PASSENGER_OVERDUE_PROMPT_KEY,
  registerCommerce,
} from "./systems/commerce/index";
export { commerceViolations } from "./systems/commerce/invariants";
export { equipmentTaskDerivation, registerEquipmentSystems } from "./systems/equipment/index";
export {
  hopCount,
  jobBlockingAcceptance,
  registerTravel,
  shortestPath,
  travelTaskDerivations,
} from "./systems/travel/index";
export { travelViolations } from "./systems/travel/invariants";
export { registerNeeds } from "./systems/needs/index";
export {
  gangwayStanderOf,
  helmWatchOf,
  isOnDuty,
  registerWatch,
  whoHasTheHelm,
} from "./systems/watch/index";
export { equipmentStages, registerWork } from "./systems/work/index";
export { workViolations } from "./systems/work/invariants";
export { registerPlannerDefaults } from "./planner/index";
export { toAgentViewSnapshot } from "./view/index";
