/**
 * Small read-only lookups over a snapshot and the content bundle, shared by the digest,
 * the capability list and the translator. Pure.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type DeepReadonly,
  type ItemDefId,
  type Job,
  type Machine,
  type MachineFault,
  type PhysicalLocation,
  type PortDefId,
  type SaveEnvelope,
  type WorldState,
  configTicks,
  hopCount,
  isOnDock,
  roomPhrase,
  shortestPath,
} from "@crew/sim";

export type Snapshot = DeepReadonly<SaveEnvelope>;
export type State = DeepReadonly<WorldState>;

export function portName(content: ContentBundle, portId: string): string {
  return content.ports[portId as PortDefId]?.name ?? portId;
}

export function itemName(content: ContentBundle, itemDefId: string): string {
  return content.items[itemDefId as ItemDefId]?.name ?? itemDefId;
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

/**
 * Where someone is, as a phrase to append: " in Galley & Mess", " on the dock" (D61: dock floor is
 * in no compartment), "" on deck between rooms, " ashore at <port>" in a port store, or
 * " in <location kind>" anywhere else off the deck.
 */
export function placePhrase(
  content: ContentBundle,
  state: State,
  location: DeepReadonly<PhysicalLocation>,
): string {
  // D63: a buyer out through the gate is in the port's market store for a few seconds.
  if (location.kind === "inExternalStore")
    return ` ashore at ${portName(content, location.portId)}`;
  if (location.kind !== "onDeck") return ` in ${location.kind}`;
  if (isOnDock(content, state, location)) return " on the dock";
  const name = compartmentNameAt(content, location.deckId, location.x, location.y);
  return name === undefined ? "" : ` in ${name}`;
}

/**
 * D95: the ship's deck: the one deck with tiles in state (the sim's `shipDeckId`, which hosts do
 * not import). A snapshot with none or several is broken, so it throws.
 */
export function shipDeckOf(state: State): string {
  const ids = Object.keys(state.deck.tiles);
  const [only] = ids;
  if (only === undefined || ids.length !== 1) {
    throw new Error(`expected exactly one ship deck in state, found ${ids.length}`);
  }
  return only;
}

/** D95: a compartment's name by its instance id (from its deck's def), or the id when unknown. */
export function compartmentName(content: ContentBundle, state: State, id: string): string {
  const compartment = state.compartments[id as keyof State["compartments"]];
  if (compartment === undefined) return id;
  const deck = Object.values(content.decks).find((d) => d.id === compartment.deckId);
  return deck?.compartments.find((c) => c.key === compartment.key)?.name ?? id;
}

/** D94: a compartment as a sentence names it ("the cargo hold", "engineering"), or the id. */
export function compartmentPhrase(content: ContentBundle, state: State, id: string): string {
  const compartment = state.compartments[id as keyof State["compartments"]];
  if (compartment === undefined) return id;
  const deck = Object.values(content.decks).find((d) => d.id === compartment.deckId);
  const def = deck?.compartments.find((c) => c.key === compartment.key);
  return def === undefined ? id : roomPhrase(def);
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

/**
 * The port a job offer can originate from right now: the docked port. D70: offers are made in
 * person at the dock, so never in flight (D42's offer on approach is gone).
 */
export function offerPortNow(state: State): PortDefId | undefined {
  const travel = state.travel;
  return travel.stage === "docked" ? travel.portId : undefined;
}

/** The length of a direct leg between two ports, or `undefined` when no route joins them. */
export function routeDistance(
  content: ContentBundle,
  fromPortId: string,
  toPortId: string,
): number | undefined {
  return content.ports[fromPortId as PortDefId]?.routes.find((r) => r.toPortId === toPortId)
    ?.distance;
}

/**
 * Passengers-and-galaxy §2.3: the shortest chain of legs between two ports, with its hop count
 * and summed distance, or `undefined` when either port is unknown or no chain joins them. The
 * same `shortestPath` the kernel prices jobs by, so the translator's pay matches the kernel's
 * band and the digest's "N hops" matches the voyage the sim will actually run.
 */
export function pathBetween(
  content: ContentBundle,
  fromPortId: string,
  toPortId: string,
):
  | { readonly path: readonly PortDefId[]; readonly hops: number; readonly distance: number }
  | undefined {
  const found = shortestPath(content.ports, fromPortId as PortDefId, toPortId as PortDefId);
  if (found === undefined) return undefined;
  return { path: found.path, hops: hopCount(found.path), distance: found.distance };
}

/** The port the ship is at or heading for next: the docked port, or the far end of the leg. */
export function portHereOrNext(state: State): PortDefId {
  const travel = state.travel;
  return travel.stage === "docked" ? travel.portId : travel.toPortId;
}

/**
 * D78: seconds of transit left on the current leg at nominal speed (a drift only lengthens it):
 * the whole leg before transit begins, zero once it is over. Zero while docked.
 */
export function transitSecondsLeft(state: State, config: DeepReadonly<ConfigDef>): number {
  const travel = state.travel;
  if (travel.stage === "docked") return 0;
  return Math.max(0, travel.routeDistance - travel.routeProgress) / config.travel.nominalSpeed;
}

/**
 * The voyage the ship is on beyond the current leg (§2.3): the voyage destination when it is set
 * and is not the port the ship is at or about to reach, with the hops and distance still to run
 * from there. Undefined for a single-leg trip or no trip at all.
 */
export function voyageAhead(
  state: State,
  content: ContentBundle,
):
  | { readonly destinationId: PortDefId; readonly hops: number; readonly distance: number }
  | undefined {
  const destinationId = state.travel.voyageDestinationId;
  if (destinationId === undefined) return undefined;
  const from = portHereOrNext(state);
  if (from === destinationId) return undefined;
  const path = pathBetween(content, from, destinationId);
  if (path === undefined) return undefined;
  return { destinationId, hops: path.hops, distance: path.distance };
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

/**
 * Passengers-and-galaxy §3.4: the fare for a passage, mirroring the kernel's `checkPassageBand`:
 * the passenger band is per unit of path distance for one fare, doubled for a round trip; the
 * tier picks a point inside it. Luggage adds nothing.
 */
export function fareFor(
  config: ConfigDef,
  distance: number,
  roundTrip: boolean,
  tier: keyof typeof PAY_TIER_FRACTION,
): { pay: number; min: number; max: number } {
  return payFor(config, "passenger", roundTrip ? distance * 2 : distance, 1, tier);
}

/**
 * Passengers-and-galaxy §3.1: the one live passage, if the current job carries a person: a job
 * accepted or under way whose `passage` has not ended. D16 allows one job at a time, so at most
 * one exists; the first by offer tick wins if a fixture breaks that rule.
 */
export function livePassage(state: State): DeepReadonly<Job> | undefined {
  const live = new Set(["accepted", "inTransit", "delivered"]);
  return Object.values(state.jobs)
    .filter(
      (j) => live.has(j.status) && j.passage !== undefined && j.passage.endReason === undefined,
    )
    .sort((a, b) => a.offeredTick - b.offeredTick || a.id.localeCompare(b.id))[0];
}
