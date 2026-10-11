/**
 * Expeditions A2 (§6, plan call 6): an errand's pay. One function, called by the kernel's band check
 * (`checkErrandBand`, `jobs.ts`) and by the narrator's translator, so the two cannot drift; the
 * narrator imports it from `@crew/sim`, never the reverse.
 *
 * Owner after the gate: W1 of expeditions A2 (the number). The gate's formula is the passenger
 * fare's over the `errand` band: per unit of path distance, there and back.
 */
import type { ConfigDef } from "../../core/types/content";

/** Fraction of a price band each pay tier sits at (W9 decision; the narrator's `payTier`). */
export const PAY_TIER_FRACTION = { low: 0.15, standard: 0.5, generous: 0.85 } as const;
export type PayTier = keyof typeof PAY_TIER_FRACTION;

/**
 * Credits for an errand over `distance` (the path to the site and back), at `tier` inside the
 * band: `priceBands.errand` per unit of distance, each end rounded; `min` and `max` are the band.
 */
export function errandPay(
  config: { readonly commerce: Pick<ConfigDef["commerce"], "priceBands"> },
  distance: number,
  tier: PayTier,
): { readonly pay: number; readonly min: number; readonly max: number } {
  const band = config.commerce.priceBands.errand;
  const min = Math.round(band.min * distance);
  const max = Math.round(band.max * distance);
  const pay = Math.round(min + PAY_TIER_FRACTION[tier] * (max - min));
  return { pay: Math.min(max, Math.max(min, pay)), min, max };
}
