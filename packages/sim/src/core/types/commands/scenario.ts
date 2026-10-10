/**
 * Scenario/fixture setup commands (SD §19.2: "scenario setup can spawn entities and faults before
 * execution"). Source `scenario` only; never reachable by the narrator or player.
 */
import type { Needs, WatchSection } from "../actor";
import type { PhysicalLocation } from "../common";
import type { ActorId, CrewDefId, ItemDefId, LocalKey, MachineId, TempRef } from "../ids";

export type ScenarioSpawn =
  | {
      readonly kind: "actor";
      readonly tempRef: TempRef;
      readonly crewDefId: CrewDefId;
      readonly location: PhysicalLocation;
      /**
       * §sections-and-dayworkers: their watch section from the scenario's bill; absent for a
       * dayworker.
       */
      readonly section?: WatchSection;
    }
  | {
      readonly kind: "item";
      readonly tempRef: TempRef;
      readonly itemDefId: ItemDefId;
      readonly count: number;
      readonly location: PhysicalLocation;
    };

export interface ScenarioCommandPayloads {
  /** Create actors/items anywhere. Temp refs are resolved and reported in `commandApplied`. */
  scenarioSpawn: { readonly spawns: readonly ScenarioSpawn[] };
  /** Put a fault on a machine now, undiagnosed. */
  scenarioInjectFault: { readonly machineId: MachineId; readonly faultKey: LocalKey };
  /** Fixture helper: overwrite some need deficits. */
  scenarioSetNeeds: { readonly actorId: ActorId; readonly needs: Partial<Needs> };
}
