/**
 * The social system (slice 4), phase `needs`: `pruneSocial` (a passenger who walked off leaves no
 * relationships or rivalries behind).
 *
 * Every tick, not every 100 as planned: `core/invariants.ts` holds relationship keys to actors at
 * the end of every tick, and a passenger despawns in the commerce sweep (`equipment`, before
 * `needs`), so pruning in the same tick keeps the invariant. The scan is a few dozen keys.
 *
 * Owner: W2 of ship life slice 4.
 */
import type { System } from "../../core/types/pipeline";
import { pruneSocial } from "./relationships";

export const SOCIAL_EVERY_TICKS = 1;

export const socialSystem: System = {
  name: "social",
  phase: "needs",
  every: SOCIAL_EVERY_TICKS,
  run(ctx) {
    pruneSocial(ctx);
  },
};
