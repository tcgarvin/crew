/**
 * Expedition commands (expeditions A1, docs/design/expeditions.md §8, plan calls 3 and 11). The
 * handlers are the expedition system's (`systems/expedition/command.ts`).
 */
import type { SiteCastEntryDef } from "../content";
import type { DecisionId, PortDefId } from "../ids";
import type { PlanId } from "../state";

export interface ExpeditionCommandPayloads {
  /**
   * Scenario (A2: the captain's card): move the docked ship to the site `siteId` in place, the
   * site's map alongside and its cast at their posts (`cast`, else the map's `defaultCast`). With
   * `plan` (an available id on the plan menu) the party musters and the fight follows; without one
   * the party waits for `adoptPlan`.
   */
  scenarioStartExpedition: {
    readonly siteId: PortDefId;
    readonly cast?: readonly SiteCastEntryDef[];
    readonly plan?: PlanId;
  };
  /** Choose the plan for the expedition waiting at the site (an available id on the menu). */
  adoptPlan: { readonly planId: PlanId };
  /** Call the party back to the ramp (§8.3 `withdrawWhen`, by order). */
  withdrawParty: Record<string, never>;
  /**
   * D105, the narrator's (and scenario's): mark one side of the pending arrival card `decisionId`
   * as the way in unseen, `planId` being that side's plan (never a `hold` plan). D106
   * (§unseen-odds): `odds` is the narrator's chance it works, a whole percent 0 to 100, unclamped.
   * Choosing that side rolls it once: the party gets in unnoticed, or the cast were waiting;
   * choosing the other, the cast were waiting (`Expedition.notice`).
   */
  markUnseen: {
    readonly decisionId: DecisionId;
    readonly planId: PlanId;
    readonly odds: number;
  };
}
