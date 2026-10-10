/**
 * Expeditions (A1, docs/design/expeditions.md §8): the start command, the plan commands and the
 * expedition system (the muster and the fight). Register after `registerSpatial` and before
 * `registerWork`: phase `actions` runs in registration order, so the fight moves people after
 * spatial and before `work.execute`.
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import type { CombatDeps } from "./combat";
import { adoptPlan, scenarioStartExpedition, withdrawParty } from "./command";
import { expeditionSystem, makeExpeditionSystem } from "./expedition";

/**
 * Register the expedition's commands and system. `options.applyDamage` replaces the damage entry
 * point (`systems/bodies/damage.ts` `applyDamage`) for tests; hosts pass nothing.
 */
export function registerExpedition(
  registry: KernelRegistry,
  options: Partial<CombatDeps> = {},
): Unregister {
  const system =
    options.applyDamage === undefined
      ? expeditionSystem
      : makeExpeditionSystem({ applyDamage: options.applyDamage });
  const unregister = [
    registry.registerSystem(system),
    registry.registerCommandHandler("scenarioStartExpedition", scenarioStartExpedition),
    registry.registerCommandHandler("adoptPlan", adoptPlan),
    registry.registerCommandHandler("withdrawParty", withdrawParty),
  ];
  return () => {
    for (const undo of unregister) undo();
  };
}

export { adoptPlan, scenarioStartExpedition, withdrawParty } from "./command";
export type { CombatDeps, DamageFn } from "./combat";
export { expeditionSystem, makeExpeditionSystem, orderWithdrawal } from "./expedition";
export { inCover, lineOfSight } from "./los";
export { fightLabel, musterLabel } from "./labels";
export { type LockerWeapon, handOutMuster, lockerWeapons, musterPlan, runArm } from "./muster";
export { DEFAULT_PLANS, fitToGo, squadFor } from "./plans";
