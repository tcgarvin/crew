/**
 * Expeditions A1 (§3.1, plan call 4): ports and sites. A site is a `PortDef` of `kind: "site"`, a
 * landing that sells nothing; until A2 it is reached only by `scenarioStartExpedition`, and the
 * narrator never sees it (its capability block, port lines and the null narrator's offers filter
 * it out with `isSite`).
 */
import type { ContentBundle } from "./types/content";
import type { PortDefId } from "./types/ids";

/** Is `portId` a landing site rather than a port? False for an unknown id. */
export function isSite(content: Pick<ContentBundle, "ports">, portId: PortDefId): boolean {
  return content.ports[portId]?.kind === "site";
}
