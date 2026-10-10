/**
 * Expeditions A1 (§8.4): the plan menu, the capability list made spatial. Pure over state, content
 * and config, so the narrator (A2) reads the same menu the kernel re-derives to validate a chosen
 * id (`scenarioStartExpedition.plan`, `adoptPlan`).
 *
 * W2 writes the cross product, pruned (§8.4): every posture × `lethal`/`stun` × the four squad
 * rules, `holdFire` only with `bait` and `creep`, `available` and `why` from the roster, the
 * locker, the site's posts and the phase; at most eight, the default pair first. Note that the
 * start command validates its `plan` before the site is alongside: the site is then
 * `state.expedition?.siteId` or the command's own, not the dock alongside.
 *
 * Gate stub: the default pair, both available.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import type { ConfigDef, ContentBundle } from "../core/types/content";
import type { ReadonlyWorldState } from "../core/types/pipeline";
import type { PlanOption } from "../core/types/view";
import { DEFAULT_PLANS } from "../systems/expedition/plans";

export function planMenu(
  _state: ReadonlyWorldState,
  _content: ContentBundle,
  _config: ConfigDef,
): PlanOption[] {
  return DEFAULT_PLANS.map((plan) => ({
    id: plan.id,
    plan,
    available: true,
    why: plan.posture === "hold" ? "hold the ramp from cover" : "go in and take them",
  }));
}
