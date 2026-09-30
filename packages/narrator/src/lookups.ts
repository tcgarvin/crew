/**
 * Small read-only lookups over a snapshot and the content bundle, shared by the digest,
 * the capability list and the translator. Pure.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type DeepReadonly,
  type Machine,
  type MachineFault,
  type PortDefId,
  type SaveEnvelope,
  type WorldState,
  configTicks,
} from "@crew/sim";

export type Snapshot = DeepReadonly<SaveEnvelope>;
export type State = DeepReadonly<WorldState>;

export function portName(content: ContentBundle, portId: string): string {
  return content.ports[portId as PortDefId]?.name ?? portId;
}

export function machineName(content: ContentBundle, machine: DeepReadonly<Machine>): string {
  return content.machines[machine.defId]?.name ?? machine.defId;
}

/** Compartment name for a tile, from the static deck grid. */
export function compartmentNameAt(
  content: ContentBundle,
  deckId: string,
  x: number,
  y: number,
): string | undefined {
  const deck = Object.values(content.decks).find((d) => d.id === deckId);
  const symbol = deck?.tiles[Math.floor(y)]?.[Math.floor(x)];
  if (deck === undefined || symbol === undefined || symbol === " ") return undefined;
  return deck.compartments.find((c) => c.symbol === symbol)?.name;
}

export function machineCompartment(
  content: ContentBundle,
  machine: DeepReadonly<Machine>,
): string | undefined {
  const deck = Object.values(content.decks).find((d) => d.id === machine.deckId);
  const placement = deck?.machines.find((p) => p.key === machine.placementKey);
  if (placement === undefined) return undefined;
  return compartmentNameAt(content, machine.deckId, placement.origin.x, placement.origin.y);
}

/**
 * Discovery of an active fault, as far as the crew knows (D7: the map shows truth, but the
 * narrator's player-facing text must still respect what the captain could plausibly know).
 * `undiscovered`: nobody has noticed a symptom and it is not diagnosed.
 */
export type FaultDiscovery = "undiscovered" | "symptomNoticed" | "diagnosed";

export function faultDiscovery(
  state: State,
  machine: DeepReadonly<Machine>,
  fault: DeepReadonly<MachineFault>,
): FaultDiscovery {
  if (fault.diagnosed) return "diagnosed";
  const factKey = `${machine.id}/machineSymptom`;
  const noticed = Object.values(state.actors).some(
    (actor) => (actor.knowledge as Record<string, unknown>)[factKey] !== undefined,
  );
  return noticed ? "symptomNoticed" : "undiscovered";
}

/** The port a job offer can originate from right now: docked port, or the approach target. */
export function offerPortNow(state: State): PortDefId | undefined {
  const travel = state.travel;
  if (travel.stage === "docked") return travel.portId;
  if (travel.stage === "approaching" || travel.stage === "docking") return travel.toPortId;
  return undefined;
}

export function routeDistance(
  content: ContentBundle,
  fromPortId: string,
  toPortId: string,
): number | undefined {
  return content.ports[fromPortId as PortDefId]?.routes.find((r) => r.toPortId === toPortId)
    ?.distance;
}

/** Relative fault windows in seconds, derived from config so they always fit the kernel bound. */
export function faultWindowSeconds(
  config: ConfigDef,
): Record<"soon" | "later" | "muchLater", readonly [number, number]> {
  const third = config.narrator.maxFaultWindowSeconds / 3;
  return {
    soon: [0, third],
    later: [third, 2 * third],
    muchLater: [2 * third, 3 * third],
  };
}

export function faultWindowTicks(
  config: ConfigDef,
  window: "soon" | "later" | "muchLater",
): readonly [number, number] {
  const [from, to] = faultWindowSeconds(config)[window];
  return [configTicks(config, from), configTicks(config, to)];
}

/** Units per quantity tier for job cargo. W9 decision. */
export const JOB_QUANTITY_UNITS = { one: 1, few: 3, several: 6 } as const;

/** Units per quantity tier for a boundary spawn, before the `maxSpawnsPerCommand` clamp. */
export const SPAWN_QUANTITY_UNITS = { one: 1, few: 2, several: 3 } as const;

/** Fraction of the price band each pay tier sits at. W9 decision. */
export const PAY_TIER_FRACTION = { low: 0.15, standard: 0.5, generous: 0.85 } as const;

/**
 * Credits for a job, mirroring the kernel's `checkPriceBand` (systems/commerce/jobs.ts): the band
 * is per unit per distance unit, rounded at each end; the tier picks a point inside it.
 */
export function payFor(
  config: ConfigDef,
  cargoClass: keyof ConfigDef["commerce"]["priceBands"],
  distance: number,
  units: number,
  tier: keyof typeof PAY_TIER_FRACTION,
): { pay: number; min: number; max: number } {
  const band = config.commerce.priceBands[cargoClass];
  const min = Math.round(band.min * distance * units);
  const max = Math.round(band.max * distance * units);
  const pay = Math.round(min + PAY_TIER_FRACTION[tier] * (max - min));
  return { pay: Math.min(max, Math.max(min, pay)), min, max };
}
