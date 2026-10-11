/**
 * Expeditions A2 (plan calls 4 and 15): the expedition's two policy cards, queued through
 * `queuePolicyDecision` (prompt keys `expedition.arrival` and `expedition.turn`) with no `jobId` on
 * the record, so each gets its `policyDecision` hook; the job is named in `prompt.params`. Each is
 * queued at most once an expedition and recorded in `Expedition.cards`.
 *
 * - The arrival card, from `startExpedition` when the expedition started itself on landing with no
 *   plan: two plans from the menu, brought by the first officer (`firstOfficerOf`), each side an
 *   `adoptPlan`.
 * - The turn card, once a fight and only in the fight: the tick of the first `combatantBroke` of
 *   either side or the first party member down or dead, "Press on" or "Pull back to the ship"
 *   (`withdrawParty`).
 *
 * Owner after the gate: W2 of expeditions A2. Gate stubs: neither card is queued.
 */
import type { ApplyCtx } from "../../core/commands";
import type { StepCtx } from "../../core/types/pipeline";
import type { Expedition } from "../../core/types/state";
import type { Fight } from "./combat";

/** Call 4: queue the arrival card for an expedition that started itself. Gate stub: no-op. */
export function queueArrivalCard(_ctx: ApplyCtx, _expedition: Expedition): void {}

/**
 * Call 15: queue the turn card when the fight turns, once; called after `runCombat`. Gate stub:
 * no-op.
 */
export function queueTurnCard(_ctx: StepCtx, _fight: Fight): void {}
