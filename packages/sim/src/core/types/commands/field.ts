/**
 * Field commands (D92): the narrator's seventh lever.
 */
import type { FieldDetection, FieldSeverity } from "../content";
import type { ScriptedImpactDraft } from "../state";

export interface FieldCommandPayloads {
  /**
   * D92, narrator: an asteroid field on this leg. It starts somewhere in `windowTicks` (relative
   * to the apply tick, sampled on the `failures` stream as `scheduleHazard`), at the first
   * `transit` tick at or after that, and spans the severity's length of route. `detection` says
   * whether the helm gets a check before it; `scripted` is up to `field.maxScripted` chosen
   * impacts. One field per leg; valid while a course is planned or the ship is underway with
   * transit ahead; rejected when the scripted impacts alone would take the hull to zero.
   */
  scheduleField: {
    readonly severity: FieldSeverity;
    readonly detection: FieldDetection;
    readonly windowTicks: readonly [number, number];
    readonly scripted: readonly ScriptedImpactDraft[];
  };
}
