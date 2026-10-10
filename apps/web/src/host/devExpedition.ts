/**
 * Expeditions A1, dev only: `?expedition=<siteId>[&plan=<planId>]` starts a fresh game and sets the
 * ship down at that site (`scenarioStartExpedition`, scenario authority), so the fight can be
 * watched in a browser before the captain's card exists (A2). `App.tsx` reads it only under
 * `import.meta.env.DEV`, so a production build carries none of this.
 */
import type { Command, CommandId, PlanId, PortDefId } from "@crew/sim";

export interface DevExpedition {
  readonly siteId: PortDefId;
  /** Absent: the party waits at the ship for a plan (`adoptPlan`). */
  readonly plan?: PlanId;
}

/** The expedition the query string asks for, or `undefined` when it asks for none. */
export function devExpeditionFromSearch(search: string): DevExpedition | undefined {
  const params = new URLSearchParams(search);
  const siteId = params.get("expedition");
  if (siteId === null || siteId === "") return undefined;
  const plan = params.get("plan");
  return {
    siteId: siteId as PortDefId,
    ...(plan === null || plan === "" ? {} : { plan }),
  };
}

/** The scenario command that starts it; the sim validates the site and the plan. */
export function devExpeditionCommand(expedition: DevExpedition): Command {
  return {
    id: "cmd:scenario:dev-expedition" as CommandId,
    source: "scenario",
    kind: "scenarioStartExpedition",
    payload: {
      siteId: expedition.siteId,
      ...(expedition.plan === undefined ? {} : { plan: expedition.plan }),
    },
  };
}
