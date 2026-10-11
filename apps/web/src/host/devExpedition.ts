/**
 * Expeditions A1, dev only: `?expedition=<siteId>[&plan=<planId>]` starts a fresh game and sets the
 * ship down at that site (`scenarioStartExpedition`, scenario authority), so the fight can be
 * watched in a browser before the captain's card exists (A2). `App.tsx` reads it only under
 * `import.meta.env.DEV`, so a production build carries none of this.
 */
import { NARRATOR_TEXT_KEYS } from "@crew/content";
import {
  type Command,
  type CommandId,
  type ConfigDef,
  type ContentBundle,
  type PlanId,
  type PortDefId,
  type ScenarioDefId,
  errandPay,
  shortestPath,
  siteNearPort,
} from "@crew/sim";

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

/**
 * Expeditions A2, dev only: `?errand=<siteId>` starts a fresh game with a `fetchPerson` errand to
 * that site offered on a card at the start port (scenario authority), as `crew episode` does, so
 * the whole episode (offer, leg, landing, arrival card, fight, home) can be played in a browser
 * without waiting for the narrator to offer one. The target is the site map's own target.
 */
export function devErrandFromSearch(search: string): PortDefId | undefined {
  const siteId = new URLSearchParams(search).get("errand");
  return siteId === null || siteId === "" ? undefined : (siteId as PortDefId);
}

/** The scenario `offerJob` for that errand; the sim validates the site, the band and the rest. */
export function devErrandCommand(
  content: ContentBundle,
  config: ConfigDef,
  fromPortId: PortDefId,
  siteId: PortDefId,
): Command {
  const near = siteNearPort(content, siteId);
  const leg = content.ports[siteId]?.routes[0]?.distance;
  const toNear = near === undefined ? undefined : shortestPath(content.ports, fromPortId, near);
  if (toNear === undefined || leg === undefined) {
    throw new Error(`dev errand: no route from ${fromPortId} to the site ${siteId}`);
  }
  const site = Object.values(content.docks ?? {}).find((dock) => dock.portId === siteId);
  const target = site?.defaultCast?.find((entry) => entry.part === "target")?.name ?? "the keeper";
  return {
    id: "cmd:scenario:dev-errand" as CommandId,
    source: "scenario",
    kind: "offerJob",
    payload: {
      surface: true,
      job: {
        issuer: { name: "Ysolde Maren", role: "grower", org: "Meridian Growers" },
        pitch: {
          key: NARRATOR_TEXT_KEYS.jobPitch,
          params: {},
          prose: `${target} owes the Growers more than money. I want them brought back to answer for it.`,
        },
        description: { key: "job.template", params: {} },
        urgency: "soon",
        fromPortId,
        toPortId: fromPortId,
        cargo: [],
        pay: errandPay(config, 2 * (toNear.distance + leg), "standard").pay,
        errand: { kind: "fetchPerson", siteId, targetName: target, wants: "alive" },
      },
    },
  };
}

/** The dev start the query string asks for (`?expedition=` first, then `?errand=`), if any. */
export function devStartCommand(
  search: string,
  content: ContentBundle,
  config: ConfigDef,
  scenarioId: ScenarioDefId,
): Command | undefined {
  const expedition = devExpeditionFromSearch(search);
  if (expedition !== undefined) return devExpeditionCommand(expedition);
  const siteId = devErrandFromSearch(search);
  if (siteId === undefined) return undefined;
  const startPortId = content.scenarios[scenarioId]?.startPortId;
  if (startPortId === undefined) throw new Error(`dev errand: no scenario ${scenarioId}`);
  return devErrandCommand(content, config, startPortId, siteId);
}
