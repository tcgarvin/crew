/**
 * Planning policies for A*: what an actor believes about doors and obstructions (SD §7.2).
 *
 * W3 decisions:
 * - Doors are planned from the static schematic (`schematicDoorSeconds`) overridden by the actor's
 *   latest `doorState` fact: `open` costs nothing, `jammed` is impassable. Movement records a
 *   `jammed` fact (certainty `suspected` unless truly jammed) when a door fails to open for the
 *   actor, so the next plan avoids it.
 * - Tile obstructions are planned from truth: V1 has no hidden obstructions (nothing but
 *   scenarios creates them, and they are visible objects), and obstruction facts would need a
 *   per-tile subject ID the contract does not have. Execution still re-checks every tile.
 *
 * Dockside spike: ramps are planned from truth too, and both policies agree on them: a fully open
 * ramp costs nothing, any other ramp is impassable. Travel alone opens and closes ramps (actors
 * never request one), and whether the ramps are down is something the whole ship knows.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";
import type { DoorId } from "../../core/types/ids";
import type { DeckGeometry, NavDoor } from "../../core/types/nav";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import { schematicDoorSeconds } from "./doors";
import { indexAt } from "./grid";
import type { PathPolicy } from "./pathfind";

/**
 * Seconds planning expects a door to cost, or null if it will not let anyone through: a ramp is
 * free while open and impassable otherwise; any other door is its schematic opening time.
 */
export function plannedDoorSeconds(
  geometry: DeckGeometry,
  nav: NavDoor,
  config: ConfigDef,
): number | null {
  if (nav.placement.kind === "ramp") return geometry.openRamps.has(nav.id) ? 0 : null;
  return schematicDoorSeconds(nav, config);
}

function plannedDoorCost(geometry: DeckGeometry, doorId: DoorId, config: ConfigDef) {
  const nav = geometry.doors.get(doorId);
  if (nav === undefined) return null;
  const seconds = plannedDoorSeconds(geometry, nav, config);
  return seconds === null ? null : seconds * config.movement.walkSpeed;
}

/**
 * The static schematic every crew member knows (SD §13.5): no facts, no dynamic state except
 * whether the ramps are open.
 */
export function schematicPolicy(geometry: DeckGeometry, config: ConfigDef): PathPolicy {
  return {
    key: "schematic",
    doorCost: (doorId) => plannedDoorCost(geometry, doorId, config),
    tileBlocked: () => false,
  };
}

/** Route planning for one actor: schematic + their door facts + visible obstructions. */
export function actorPolicy(
  state: ReadonlyWorldState,
  geometry: DeckGeometry,
  actor: DeepReadonly<Actor>,
  config: ConfigDef,
): PathPolicy {
  const beliefs = new Map<DoorId, string>();
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType === "doorState" && geometry.doors.has(fact.subjectId as DoorId)) {
      beliefs.set(fact.subjectId as DoorId, fact.value.physicalState);
    }
  }
  const revision = state.deck.geometryRevision;
  return {
    key:
      beliefs.size === 0
        ? `s${revision}`
        : `a${actor.id}:${actor.navigationKnowledgeRevision}:${revision}`,
    doorCost(doorId) {
      if (geometry.doors.get(doorId)?.placement.kind === "ramp") {
        return plannedDoorCost(geometry, doorId, config);
      }
      const belief = beliefs.get(doorId);
      if (belief === "jammed") return null;
      if (belief === "open") return 0;
      return plannedDoorCost(geometry, doorId, config);
    },
    tileBlocked: (x, y) => geometry.obstructed[indexAt(geometry, x, y)] === 1,
  };
}
