/**
 * Writing beliefs into an actor's latest-belief table (W0 decision 16: one fact per
 * `(subject, factType)`, no history). Used by minimal perception and by work when an action
 * discovers a discrepancy.
 */
import type { Actor, FactType, FactValues, KnownFact } from "../../core/types/actor";
import type { PhysicalLocation, Tick } from "../../core/types/common";
import type { ActorId, EntityId, ItemId, MachineId } from "../../core/types/ids";

export interface FactSource {
  readonly tick: Tick;
  readonly sourceId: ActorId | MachineId;
  readonly evidence: KnownFact["evidence"];
  readonly certainty: KnownFact["certainty"];
}

export function writeFact<T extends FactType>(
  actor: Actor,
  subjectId: EntityId,
  factType: T,
  value: FactValues[T],
  source: FactSource,
): void {
  const fact = {
    subjectId,
    factType,
    value,
    observedTick: source.tick,
    learnedTick: source.tick,
    sourceId: source.sourceId,
    evidence: source.evidence,
    certainty: source.certainty,
  } as KnownFact;
  actor.knowledge[`${subjectId}/${factType}`] = fact;
}

export function directSight(actor: Actor, tick: Tick): FactSource {
  return { tick, sourceId: actor.id, evidence: "direct", certainty: "confirmed" };
}

/** The actor sees for themselves that `itemId` is at `location`. */
export function seeItem(
  actor: Actor,
  itemId: ItemId,
  location: PhysicalLocation,
  tick: Tick,
): void {
  writeFact(actor, itemId, "itemLocation", { location }, directSight(actor, tick));
}
