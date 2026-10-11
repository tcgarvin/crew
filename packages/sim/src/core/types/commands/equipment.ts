/**
 * Equipment commands (review §D.3 `scheduleFault`; D106 `injectFault` and `reveal`,
 * §forced-faults-and-hazards and §thought-and-reveal-levers).
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
  /**
   * D106, narrator and scenario: the machine develops `faultKey`, one of its own catalogued
   * faults, now, through the one fault path (`applyFault`: the symptom problem opens by the usual
   * rule). Refused on a machine that has or awaits it. Spends the fault budget (advice).
   */
  injectFault: { readonly machineId: MachineId; readonly faultKey: LocalKey };
  /**
   * D106: the crew notice the symptom of `faultKey` on `machineId`, an active, undiagnosed fault:
   * its symptom problem goes public and the best engineer aboard learns of it (`faultObserved`).
   */
  reveal: { readonly machineId: MachineId; readonly faultKey: LocalKey };
}
