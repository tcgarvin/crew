/**
 * Small helpers the candidate builders share (`candidates.ts`, and the watch's `helm.ts` and
 * `rounds.ts`): backoff, building a personal candidate, and finding a floor spot in a compartment
 * by tag. Pure over the `AgentView`.
 */
import type { TileCoord } from "../core/types/common";
import type { DeepReadonly } from "../core/types/common";
import type { CompartmentDef } from "../core/types/content";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, KnownItemView } from "../core/types/view";
import type { UrgencyClass } from "../core/types/work";
import type { Candidate } from "./candidates";

export function needUrgency(value: number, config: PlannerConfig): UrgencyClass | undefined {
  if (value > config.urgency.needSurvivalAbove) return "immediateSurvival";
  if (value > config.urgency.needEssentialAbove) return "essentialOperation";
  if (value > config.needs.seekThreshold) return "routineObligation";
  return undefined;
}

export const inMyHands = (view: AgentView, item: KnownItemView): boolean =>
  item.location.kind === "carriedBy" && item.location.actorId === view.self.id;

/** Is `tile` in a compartment carrying `tag`? */
export function inCompartmentTagged(view: AgentView, tile: TileCoord, tag: string): boolean {
  const symbol = view.schematic.deck.tiles[tile.y]?.[tile.x];
  return view.schematic.deck.compartments.some((c) => c.symbol === symbol && c.tags.includes(tag));
}

export const backingOff = (view: AgentView, ref: string): boolean => {
  const until = view.self.backoff?.[ref];
  return until !== undefined && view.tick < until;
};

export const sameTile = (a: TileCoord, b: TileCoord): boolean => a.x === b.x && a.y === b.y;

export function personal(
  ref: string,
  urgency: UrgencyClass,
  estimateTicks: number,
  tick: number,
  choice: Extract<Candidate["choice"], { kind: "personal" }>,
): Candidate {
  return { ref, urgency, estimateTicks, skill: 0, ageTick: tick, stableId: ref, choice };
}

export type CompartmentView = DeepReadonly<CompartmentDef>;

/** The first compartment carrying one of `tags`, in tag order. */
export function compartmentTagged(
  view: AgentView,
  tags: readonly string[],
): CompartmentView | undefined {
  const deck = view.schematic.deck;
  return tags
    .map((tag) => deck.compartments.find((c: CompartmentView) => c.tags.includes(tag)))
    .find((c) => c !== undefined);
}

/** Deterministic per-actor floor spot in the first compartment carrying one of `tags`. */
export function loungeTile(view: AgentView, tags: readonly string[]): TileCoord | undefined {
  const deck = view.schematic.deck;
  const compartment = compartmentTagged(view, tags);
  if (compartment === undefined) return undefined;
  const reserved = view.schematic.machines().flatMap((m) => m.interactionTiles.map((t) => t.tile));
  const tiles: TileCoord[] = [];
  deck.tiles.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const tile = { x, y };
      if (row[x] !== compartment.symbol || !view.schematic.isFloor(tile)) continue;
      if (reserved.some((r) => sameTile(r, tile))) continue;
      tiles.push(tile);
    }
  });
  if (tiles.length === 0) return undefined;
  let hash = 0;
  for (const ch of view.self.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return tiles[hash % tiles.length];
}
