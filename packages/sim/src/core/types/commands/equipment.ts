/**
 * Equipment commands (review §D.3 `scheduleFault`).
 */
import type { LocalKey, MachineId } from "../ids";

export interface EquipmentCommandPayloads {
  /**
   * Schedule a fault from the machine's own catalog. The kernel samples the exact tick inside the
   * window from the `failures` stream, so the narrator cannot time it to a person's position (D6).
   * W0 decision: `windowTicks` is relative to the apply tick, `[earliest, latest]` inclusive,
   * with `latest - earliest` bounded by `config.narrator.maxFaultWindowSeconds`; the field is
   * `faultKey` (not `faultType`) to match `FaultDef.key`.
   */
  scheduleFault: {
    readonly machineId: MachineId;
    readonly faultKey: LocalKey;
    readonly windowTicks: readonly [number, number];
  };
}
