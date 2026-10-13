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
  checkErrandBand,
  commerceTaskDerivations,
  errandPay,
  marketBlock,
  PASSENGER_OVERDUE_PROMPT_KEY,
  PAY_TIER_FRACTION,
  type PayTier,
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
  galleyTaskDerivations,
  provisionsCratesAboard,
  provisionsDays,
  registerGalley,
} from "./systems/galley/index";
export { dirtTaskDerivations, dirtViolations, registerDirt } from "./systems/dirt/index";
export { registerRecreation } from "./systems/recreation/index";
export { registerSocial } from "./systems/social/index";
export { registerCabins } from "./systems/cabins/index";
export { registerField, scriptedHullDamage } from "./systems/field/index";
export { damageTaskDerivations, registerDamage } from "./systems/damage/index";
export { registerIntercom } from "./systems/intercom/index";
export {
  type MedBed,
  medBedOf,
  medicalTaskDerivations,
  medicalUnitsAboard,
  onTheBed,
  registerMedical,
} from "./systems/medical/index";
export {
  applyDamage,
  type DamageResult,
  type Hit,
  registerBodies,
} from "./systems/bodies/index";
export {
  DEFAULT_PLANS,
  ITEM_DEFAULT_PLANS,
  defaultPairFor,
  lockerWeapons,
  registerExpedition,
  squadFor,
} from "./systems/expedition/index";
export { interestScore } from "./core/interests";
export { affinitiesFrom, affinityOf, compatibility } from "./core/social";
export {
  gangwayStanderOf,
  helmWatchOf,
  isOnDuty,
  registerWatch,
  whoHasTheHelm,
} from "./systems/watch/index";
export { equipmentStages, registerWork } from "./systems/work/index";
export { workViolations } from "./systems/work/invariants";
export { cleaningRolesFor } from "./planner/cleaning";
export {
  type Candidate,
  type Rejection,
  type Weighing,
  registerPlannerDefaults,
  weighOptions,
} from "./planner/index";
export { planMenu, toAgentViewSnapshot } from "./view/index";
