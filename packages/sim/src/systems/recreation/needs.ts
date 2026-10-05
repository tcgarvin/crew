/**
 * Recreation's part in the needs system (slice 4, call 1): while a `recreate` step is counting
 * (solo, or the session started), `restores.<need> / durationDays` per day off each need it
 * restores and `fatigueCost / durationDays` per day onto fatigue, so an interrupted game restores
 * in proportion. Waiting for others restores nothing. Read by `systems/needs/needs.ts`
 * `needRatesPerDay`, which merges the returned per-day rates over its own (and otherwise has
 * recreation rise at `needs.recreationPerDay`).
 *
 * Owner: W1 of ship life slice 4. Gate stub: undefined (nobody recreates).
 */
import type { Actor, NeedKey } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";

/** Signed per-day need rates replacing the needs system's while `actor` recreates. */
export function recreationRatesFor(
  _ctx: StepCtx,
  _actor: Actor,
): Partial<Record<NeedKey, number>> | undefined {
  return undefined;
}
