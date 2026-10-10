/**
 * Expeditions (A1, docs/design/expeditions.md §8): the start command, the plan commands and the
 * expedition system (the muster and the fight). Register after `registerSpatial` and before
 * `registerWork`: phase `actions` runs in registration order, so the fight moves people after
 * spatial and before `work.execute`.
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { adoptPlan, scenarioStartExpedition, withdrawParty } from "./command";
import { expeditionSystem } from "./expedition";

export function registerExpedition(registry: KernelRegistry): Unregister {
  const unregister = [
    registry.registerSystem(expeditionSystem),
    registry.registerCommandHandler("scenarioStartExpedition", scenarioStartExpedition),
    registry.registerCommandHandler("adoptPlan", adoptPlan),
    registry.registerCommandHandler("withdrawParty", withdrawParty),
  ];
  return () => {
    for (const undo of unregister) undo();
  };
}

export { adoptPlan, scenarioStartExpedition, withdrawParty } from "./command";
export { expeditionSystem, orderWithdrawal } from "./expedition";
export { fightLabel, musterLabel } from "./labels";
export { type LockerWeapon, handOutMuster, lockerWeapons, musterPlan, runArm } from "./muster";
export { DEFAULT_PLANS, fitToGo, squadFor } from "./plans";
