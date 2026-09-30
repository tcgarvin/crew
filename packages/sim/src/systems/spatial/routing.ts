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
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";
import type { DoorId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import { schematicDoorSeconds } from "./doors";
import type { PathPolicy } from "./pathfind";

function schematicDoorCost(geometry: DeckGeometry, doorId: DoorId, config: ConfigDef) {
  const nav = geometry.doors.get(doorId);
  if (nav === undefined) return null;
  const seconds = schematicDoorSeconds(nav, config);
  return seconds === null ? null : seconds * config.movement.walkSpeed;
}

/** The static schematic every crew member knows (SD §13.5): no facts, no dynamic state. */
export function schematicPolicy(geometry: DeckGeometry, config: ConfigDef): PathPolicy {
  return {
    key: "schematic",
    doorCost: (doorId) => schematicDoorCost(geometry, doorId, config),
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
      const belief = beliefs.get(doorId);
      if (belief === "jammed") return null;
      if (belief === "open") return 0;
      return schematicDoorCost(geometry, doorId, config);
    },
    tileBlocked: (x, y) => geometry.obstructed[y * geometry.width + x] === 1,
  };
}
