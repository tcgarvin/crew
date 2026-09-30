/** Equipment and power events (W5). */
import type { LocalKey, MachineId } from "../ids";
import type { OperatingMode } from "../ship";
import type { SignificanceCatalog } from "./significance";

export interface EquipmentEventPayloads {
  /** Truth: a fault now exists (whether or not anyone knows). */
  faultOccurred: { readonly machineId: MachineId; readonly faultKey: LocalKey };
  /** An actor noticed a symptom (subject: observer and machine). */
  faultObserved: { readonly machineId: MachineId; readonly symptomKey: LocalKey };
  faultDiagnosed: { readonly machineId: MachineId; readonly faultKey: LocalKey };
  faultRepaired: { readonly machineId: MachineId; readonly faultKey: LocalKey };
  machineDerated: {
    readonly machineId: MachineId;
    readonly output: number;
    readonly cause: "power" | "heat" | "fault";
  };
  machineModeChanged: {
    readonly machineId: MachineId;
    readonly from: OperatingMode;
    readonly to: OperatingMode;
  };
  breakerTripped: { readonly domainKey: LocalKey };
  maintenanceCompleted: { readonly machineId: MachineId };
}

export const EQUIPMENT_EVENT_SIGNIFICANCE = {
  faultOccurred: "trace",
  faultObserved: "notable",
  faultDiagnosed: "notable",
  faultRepaired: "narrative",
  machineDerated: "notable",
  machineModeChanged: "trace",
  breakerTripped: "notable",
  maintenanceCompleted: "trace",
} as const satisfies SignificanceCatalog<EquipmentEventPayloads>;
