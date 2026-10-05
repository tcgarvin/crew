/**
 * Recreation's part in the needs system (slice 4, call 1): while a `recreate` step is counting
 * (solo, or the session started), `restores.<need> / durationDays` per day off each need it
 * restores and `fatigueCost / durationDays` per day onto the waking fatigue rate, so an
 * interrupted game restores in proportion. Waiting for others restores nothing. A group game's
 * `solo` variant restores by its own `restores` over its own `durationDays`. Read by
 * `systems/needs/needs.ts` `needRatesPerDay`, which merges the returned per-day rates over its
 * own (and otherwise has recreation rise at `needs.recreationPerDay`).
 *
 * Owner: W1 of ship life slice 4.
 */
import type { Actor, NeedKey } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import { isPlaying, playedAs, playsVariant, recreateStepOf } from "./common";

/** Signed per-day need rates replacing the needs system's while `actor` recreates. */
export function recreationRatesFor(
  ctx: StepCtx,
  actor: Actor,
): Partial<Record<NeedKey, number>> | undefined {
  const step = recreateStepOf(actor);
  if (step === undefined || !isPlaying(ctx.state, actor, step)) return undefined;
  const def = ctx.content.activities[step.activityId];
  if (def === undefined) return undefined;
  const { restores, durationDays } = playedAs(def, step.role);
  if (durationDays <= 0) return undefined;
  const rates: Partial<Record<NeedKey, number>> = {};
  for (const [need, total] of Object.entries(restores) as [NeedKey, number][]) {
    rates[need] = -total / durationDays;
  }
  if (def.fatigueCost !== undefined && !playsVariant(def, step.role)) {
    rates.fatigue = ctx.config.needs.fatiguePerDayAwake + def.fatigueCost / def.durationDays;
  }
  return rates;
}
