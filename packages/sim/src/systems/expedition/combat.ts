/**
 * Expeditions A1 (§8.1): the combatant loop. Every `decideEverySeconds`, staggered by actor index,
 * each combatant picks one action (`actions.ts`) by state and side; noticing in `approach`; the
 * fight's start (`expeditionContact`, the alert); aim, shots and hits through `applyDamage`.
 *
 * Gate stub: nothing runs.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import type { StepCtx } from "../../core/types/pipeline";

/** One tick of the fight. Gate stub: no-op. */
export function runCombat(_ctx: StepCtx): void {}
