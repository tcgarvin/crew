export * from "./core/index";
export { SYSTEMS_PLACEHOLDER } from "./systems/index";
export { PLANNER_PLACEHOLDER } from "./planner/index";
export { VIEW_PLACEHOLDER } from "./view/index";

/**
 * W0 decision (Integration 1): explicit re-exports from `systems/spatial` for hosts (the web
 * worker, tests). Deliberately not `export *` — `systems/index.ts` also aggregates
 * power/equipment/travel/commerce, which are mid-flight; re-exporting everything from here would
 * make this file's build depend on their in-progress state. Add names here as a host needs them.
 */
export {
  compartmentAt,
  deckGeometry,
  isWalkable,
  registerSpatial,
  requestMove,
  type MoveTarget,
} from "./systems/spatial/index";
// `rotateOffset` isn't re-exported from `systems/spatial/index` yet; import straight from its
// module rather than editing that aggregator (out of scope for Integration 1).
export { rotateOffset } from "./systems/spatial/geometry";

/** Commerce (W6) is complete enough for hosts to register: the narrator package's own tests need
 * it to enqueue `spawnAtBoundary`/`offerJob`/etc. through a real kernel. */
export { affordableUnits, marketBlock, registerCommerce } from "./systems/commerce/index";

/**
 * Integration 2: everything a host needs to build the full V1 registry (see
 * `apps/web/src/worker/registry.ts` for the order).
 */
export { equipmentTaskDerivation, registerEquipmentSystems } from "./systems/equipment/index";
export { registerTravel, travelTaskDerivations } from "./systems/travel/index";
export { commerceTaskDerivations } from "./systems/commerce/index";
export { registerNeeds } from "./systems/needs/index";
export {
  equipmentStages,
  registerWork,
  type RegisterWorkOptions,
  type StageExecutor,
} from "./systems/work/index";
export { workViolations } from "./systems/work/invariants";
export { spatialViolations } from "./systems/spatial/invariants";
export { registerPlannerDefaults } from "./planner/index";
export { registerAgentView, toAgentViewSnapshot } from "./view/index";
