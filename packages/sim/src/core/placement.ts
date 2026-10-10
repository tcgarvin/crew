/**
 * Machine instances from deck placements (expeditions A1, plan call 13): the one path world
 * creation (`instantiateDeck`) and the 12 → 13 save migration (the arms locker) both take.
 */
import { allocateId } from "./ids";
import type { ContentBundle, DeckDef, MachinePlacementDef } from "./types/content";
import type { MachineId } from "./types/ids";
import type { Machine } from "./types/ship";
import type { WorldState } from "./types/state";

/**
 * One machine placement of `deck` as a fresh machine (the `instantiateDeck` path for one
 * placement): on at full output, new, at ambient, its failure threshold `threshold` (a unit
 * exponential drawn on the `failures` stream at world creation). Expeditions A1 (plan call 13):
 * exported so the 12 → 13 migration can add the arms locker to a save that lacks it. Throws on a
 * machine def content lacks.
 */
export function instantiatePlacement(
  state: Pick<WorldState, "machines" | "nextId">,
  deck: DeckDef,
  placement: MachinePlacementDef,
  content: Pick<ContentBundle, "machines">,
  threshold: number,
): MachineId {
  const def = content.machines[placement.machineDefId];
  if (def === undefined) {
    throw new Error(`Deck "${deck.id}" places unknown machine "${placement.machineDefId}"`);
  }
  const id = allocateId(state, "machine");
  const machine: Machine = {
    id,
    defId: def.id,
    deckId: deck.id,
    placementKey: placement.key,
    integrity: 1,
    condition: 1,
    desiredMode: "on",
    actualMode: "on",
    output: 1,
    powerAllocatedKw: 0,
    temperature: 0,
    faults: [],
    scheduledFaults: [],
    failure: { accumulatedHazard: 0, threshold },
    lastMaintainedTick: 0,
    maintenanceProgress: 0,
    roleState:
      def.power.role === "battery"
        ? { role: "battery", storedKj: def.power.capacityKj }
        : { role: "none" },
  };
  state.machines[id] = machine;
  return id;
}
