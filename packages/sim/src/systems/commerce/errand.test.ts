/**
 * Expeditions A2 W1 (§6, plan call 6): `errandPay`, the one pay function the kernel's band check
 * and the narrator's translator share. The kernel must accept what it gives at every tier, from the
 * site's near port and from a port beyond it. The real bundle's Hub → Harrow End run is pinned in
 * `apps/cli`; here its numbers are pinned against the default band.
 */
import { describe, expect, it } from "vitest";
import { TINY } from "../../core/fixtures/tiny-content";
import type { ConfigDef } from "../../core/types/content";
import { SITE } from "../expedition/fixtures/site";
import { PAY_TIER_FRACTION, type PayTier, errandPay } from "./errand";
import { errandWorld } from "./fixtures-errand";
import { checkErrandBand } from "./jobs";

const TIERS = Object.keys(PAY_TIER_FRACTION) as PayTier[];

/** The default config's errand band (`packages/content/data/config/default.json`). */
const DEFAULT_BANDS = {
  commerce: {
    priceBands: { errand: { min: 6, max: 12 } } as ConfigDef["commerce"]["priceBands"],
  },
};

describe("errandPay (plan call 6)", () => {
  it.each([
    [TINY.port, 20],
    [TINY.port2, 80],
  ])(
    "pays inside the kernel's band at every tier from %s (%i there and back)",
    (from, distance) => {
      const { world } = errandWorld();
      const ctx = { content: world.content, config: world.config.values, state: world.state };
      for (const tier of TIERS) {
        const { pay, min, max } = errandPay(world.config.values, distance, tier);
        expect(checkErrandBand(ctx, from, SITE.port, pay), tier).toBeNull();
        expect(checkErrandBand(ctx, from, SITE.port, min), tier).toBeNull();
        expect(checkErrandBand(ctx, from, SITE.port, max), tier).toBeNull();
      }
    },
  );

  it("is the band per unit of distance there and back, the tier a point inside it", () => {
    // The Hub to Harrow End via Green Meridian and back: (45 + 20) × 2.
    expect(errandPay(DEFAULT_BANDS, 130, "low")).toEqual({ pay: 897, min: 780, max: 1560 });
    expect(errandPay(DEFAULT_BANDS, 130, "standard").pay).toBe(1170);
    expect(errandPay(DEFAULT_BANDS, 130, "generous").pay).toBe(1443);
    expect(errandPay(DEFAULT_BANDS, 0, "generous")).toEqual({ pay: 0, min: 0, max: 0 });
  });
});
